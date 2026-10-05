// S8: agents learn from the user's feedback. A thumbs down queues a learning review; an agent can
// propose new standing instructions (agent.update), which change only once the user approves, and
// never touch its tools or scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRequest } from "../src/core/approvals.mjs";
import { parseAgentFile } from "../src/core/agents.mjs";
import { definitionHash, updateAgent } from "../src/io/team.mjs";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { testConfig } from "./team-config.mjs";

const OPS = [
  "---",
  "name: ops",
  "description: Ops",
  "tools: Read, Write, Edit, Glob, Grep",
  "model: sonnet",
  "---",
  "",
  "You are Ops. Answer briefly.",
  "",
].join("\n");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "crew-learn-"));
  const brainDir = join(root, "brain");
  const agentsDir = join(root, "agents");
  mkdirSync(join(brainDir, "system", "agents"), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "ops.md"), OPS);
  writeFileSync(join(brainDir, "system", "agents", "ops.md"), OPS);
  const store = new Store(":memory:");
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain: brainDir, agentsDir, runs: root, crewGuard: "guard.mjs" },
    bin: "none",
    runTurn: () => {
      throw new Error("no runs here");
    },
    sessions: () => [],
    updateAgent,
    definitionHash,
  });
  hub.stop();
  return { root, brainDir, agentsDir, store, hub };
}

test("a thumbs down queues one learning review carrying the feedback", () => {
  const { root, store, hub } = setup();
  try {
    store.addMessage({ agent: "ops", role: "agent", text: "AdMob is fine, probably.", at: 1 });
    const reply = store.messages("ops").at(-1);
    assert.deepEqual(hub.feedback("ops", { messageId: reply.id, rating: "up" }), {
      ok: true,
      review: null,
    });
    const first = hub.feedback("ops", {
      messageId: reply.id,
      rating: "down",
      note: "Check the console before saying fine",
    });
    assert.ok(first.review);
    const job = store.job(first.review);
    assert.equal(job.kind, "learn");
    assert.match(job.prompt, /Liked on your reply: "AdMob is fine, probably\."/);
    assert.match(job.prompt, /Not right .*The user's note: Check the console/);
    assert.match(job.prompt, /agent\.update/);

    // While that review waits, more feedback collects for the next one instead.
    assert.equal(hub.feedback("ops", { rating: "down" }).review, null);
    assert.throws(() => hub.feedback("ops", { rating: "meh" }), /up or down/);
    assert.throws(() => hub.feedback("nobody", { rating: "up" }), /no agent/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent.update replaces only the instructions, keeps a backup, and refuses stale requests", () => {
  const { root, brainDir, agentsDir } = setup();
  try {
    const payload = validateRequest(
      {
        type: "agent.update",
        summary: "Ops checks the console before calling things fine",
        payload: {
          id: "OPS",
          instructions: "You are Ops. Check the console before saying something is fine.",
          change: "Adds a rule to verify before reassuring, after Maya's thumbs down.",
        },
      },
      { brainDir },
    ).payload;
    const hash = definitionHash(agentsDir, "ops");

    const out = updateAgent(payload, {
      brainDir,
      agentsDir,
      today: "2026-10-05",
      expectHash: hash,
    });
    assert.equal(out.status, "executed", out.result);
    const def = parseAgentFile(readFileSync(join(agentsDir, "ops.md"), "utf8"));
    assert.deepEqual(def.tools, ["Read", "Write", "Edit", "Glob", "Grep"], "tools unchanged");
    assert.match(def.body, /Check the console/);
    assert.doesNotMatch(def.body, /Answer briefly/);
    assert.equal(
      readFileSync(join(brainDir, "system", "agents", "ops.md"), "utf8"),
      readFileSync(join(agentsDir, "ops.md"), "utf8"),
    );
    const backups = readdirSync(join(brainDir, "system", "agents", "history"));
    assert.equal(backups.length, 1);
    assert.match(
      readFileSync(join(brainDir, "system", "agents", "history", backups[0]), "utf8"),
      /Answer briefly/,
    );

    // The file changed since the request: nothing is overwritten.
    assert.equal(
      updateAgent(payload, { brainDir, agentsDir, today: "2026-10-05", expectHash: hash }).status,
      "stale",
    );
    assert.ok(!existsSync(join(agentsDir, "nobody.md")));
    assert.equal(
      updateAgent(
        { ...payload, id: "nobody" },
        { brainDir, agentsDir, today: "x", expectHash: null },
      ).status,
      "failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent may propose changes to its own instructions only; the CEO for anyone", () => {
  const { root, store, hub } = setup();
  try {
    const running = (agent) => {
      const job = store.addJob({ agent, kind: "learn", priority: 3, prompt: "x", createdAt: 1 });
      store.updateJob(job.id, { status: "running" });
      return job.id;
    };
    const request = (agent, id) => ({
      jobId: running(agent),
      agent,
      type: "agent.update",
      summary: "change",
      payload: { id, instructions: "You are better.", change: "Better." },
    });
    assert.throws(() => hub.requestApproval(request("social", "ops")), /your own instructions/);
    const own = hub.requestApproval(request("ops", "ops"));
    assert.ok(own.preconditions.definition, "the definition's hash is recorded");
    assert.ok(hub.requestApproval(request("ceo", "ops")));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
