// One conversation: turns the user had with an agent in a terminal show up in Crew too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalTurns } from "../src/core/transcript.mjs";
import { testConfig } from "./team-config.mjs";

const user = (text, promptSource, t = "2026-10-05T10:00:00Z", extra = {}) => ({
  type: "user",
  promptSource,
  timestamp: t,
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (blocks, t = "2026-10-05T10:00:05Z") => ({
  type: "assistant",
  timestamp: t,
  message: { role: "assistant", content: blocks },
});

test("terminal turns are found; Crew's own (sdk) turns are left to Crew", () => {
  const entries = [
    user("Crew test from Maya", "sdk"),
    assistant([{ type: "text", text: "Crew reply" }]),
    user("from the terminal: what's left on AdMob?", undefined, "2026-10-05T11:00:00Z"),
    assistant([{ type: "tool_use", name: "Read", input: {} }]),
    { type: "user", message: { content: [{ type: "tool_result", content: "file text" }] } },
    assistant([{ type: "text", text: "Only the site check." }], "2026-10-05T11:00:09Z"),
    assistant([{ type: "text", text: "Want me to email Google?" }], "2026-10-05T11:00:10Z"),
    user("<command-name>/clear</command-name>", undefined),
    user("Back to Crew", "sdk"),
    assistant([{ type: "text", text: "Crew again" }]),
  ];
  assert.deepEqual(terminalTurns(entries), [
    {
      role: "you",
      text: "from the terminal: what's left on AdMob?",
      at: Date.parse("2026-10-05T11:00:00Z"),
    },
    {
      role: "agent",
      text: "Only the site check.\n\nWant me to email Google?",
      at: Date.parse("2026-10-05T11:00:10Z"),
    },
  ]);
});

test("meta and subagent lines are ignored", () => {
  assert.deepEqual(
    terminalTurns([
      user("hidden", undefined, undefined, { isMeta: true }),
      user("subagent prompt", undefined, undefined, { isSidechain: true }),
    ]),
    [],
  );
});

test("the hub brings terminal turns into the agent's chat once, after the session settles", async () => {
  const { Store } = await import("../src/io/store.mjs");
  const { Hub } = await import("../src/hub.mjs");
  const { tmpdir } = await import("node:os");
  let clock = Date.parse("2026-10-05T12:00:00Z");
  const transcript = {
    entries: [
      user("crew turn", "sdk"),
      assistant([{ type: "text", text: "crew reply" }]),
      user("terminal question", undefined, "2026-10-05T11:00:00Z"),
      assistant([{ type: "text", text: "terminal answer" }], "2026-10-05T11:00:05Z"),
    ],
    mtimeMs: clock - 10_000, // still being written
  };
  const store = new Store(":memory:");
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain: tmpdir(), agentsDir: tmpdir(), runs: tmpdir() },
    bin: "none",
    runTurn: () => {
      throw new Error("no runs");
    },
    sessions: () => [],
    now: () => clock,
    readTranscript: (sid) => (sid === "sid-1" ? transcript : null),
  });
  hub.stop();
  try {
    const thread = store.createThread({
      agent: "ops",
      sessionId: "sid-1",
      createdAt: 1,
      agentHash: "h",
    });
    store.markThreadStarted(thread.id);
    assert.equal(hub.syncTerminal("ops"), 0, "a transcript still being written waits");
    clock += 120_000;
    assert.equal(hub.syncTerminal("ops"), 2);
    assert.deepEqual(
      hub.messages("ops").map((m) => [m.role, m.text]),
      [
        ["you", "terminal question"],
        ["agent", "terminal answer"],
      ],
    );
    assert.equal(hub.syncTerminal("ops"), 0, "only once");
  } finally {
    store.close();
  }
});
