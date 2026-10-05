import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentFile, STARTER_TEAM } from "../src/core/agents.mjs";
import { parseStreamLine, contextTokens } from "../src/core/stream.mjs";
import { buildArgs, crewNote, runSettings } from "../src/core/policy.mjs";
import { admit, PRIORITY, usageLimit } from "../src/core/budget.mjs";
import { rotationReason, handover, ROTATION } from "../src/core/rotation.mjs";

const SOCIAL = `---
name: social
description: Maya's social lead. Use for posts.
tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Skill
model: sonnet
memory: user
hooks:
  PreToolUse:
    - matcher: "Read"
---

You are the **Social** department.
`;

test("parseAgentFile reads the flat front matter and the body, skipping nested blocks", () => {
  const def = parseAgentFile(SOCIAL.replace(/\n/g, "\r\n"));
  assert.equal(def.name, "social");
  assert.deepEqual(def.tools, [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "Skill",
  ]);
  assert.equal(def.model, "sonnet");
  assert.equal(def.memory, "user");
  assert.equal(def.body, "You are the **Social** department.");
  assert.throws(() => parseAgentFile("no front matter"), /front matter/);
});

test("a new Crew starts with a CEO and three generalists", () => {
  assert.deepEqual(
    STARTER_TEAM.map((a) => a.id),
    ["ceo", "research", "writer", "builder"],
  );
});

test("stream lines become init, text, tool, limits and result events", () => {
  assert.deepEqual(
    parseStreamLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s",
        tools: ["Read"],
        model: "m",
      }),
    ),
    [{ kind: "init", sessionId: "s", tools: ["Read"], model: "m" }],
  );
  const assistant = parseStreamLine(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", name: "Write", input: { file_path: "a" } },
        ],
        usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      },
    }),
  );
  assert.deepEqual(assistant, [
    { kind: "text", text: "hi", contextTokens: 125 },
    { kind: "tool", name: "Write", input: { file_path: "a" } },
  ]);
  const [limits] = parseStreamLine(
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 9,
        unifiedWindows: { five_hour: { utilization: 0.28 }, seven_day: { utilization: 0.31 } },
      },
    }),
  );
  assert.deepEqual(limits, {
    kind: "limits",
    fiveHour: 0.28,
    sevenDay: 0.31,
    resetsAt: 9,
    status: "allowed",
  });
  const [result] = parseStreamLine(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OK",
      session_id: "s",
      num_turns: 1,
      permission_denials: [{ tool_name: "Write" }],
    }),
  );
  assert.equal(result.text, "OK");
  assert.equal(result.isError, false);
  assert.equal(result.denials.length, 1);
  assert.deepEqual(parseStreamLine("not json"), []);
  assert.deepEqual(parseStreamLine('{"type":"queue-operation"}'), []);
  assert.equal(contextTokens(null), null);
});

test("buildArgs starts the agent the way the terminal does, plus Crew's gate and every drive", () => {
  const base = {
    agent: "social",
    sessionId: "U",
    settingsPath: "s.json",
    appendPrompt: "note",
    dirs: ["C:/", "E:/"],
  };
  const first = buildArgs({ ...base, resume: false });
  const next = buildArgs({ ...base, resume: true });
  assert.deepEqual(first.slice(first.indexOf("--session-id"), first.indexOf("--session-id") + 2), [
    "--session-id",
    "U",
  ]);
  assert.ok(next.includes("--resume") && !next.includes("--session-id"));
  assert.equal(first[first.indexOf("--agent") + 1], "social");
  assert.equal(first[first.indexOf("--permission-mode") + 1], "bypassPermissions");
  for (const old of ["--tools", "--agents", "--setting-sources", "--allowedTools"]) {
    assert.ok(
      !first.includes(old),
      `${old} is gone: Maya's own settings, skills and connectors load`,
    );
  }
  assert.equal(first.filter((x) => x === "--add-dir").length, 2);
  assert.ok(!first.includes("--disallowedTools"));
  const tainted = buildArgs({ ...base, resume: false, tainted: true });
  assert.equal(tainted[tainted.indexOf("--disallowedTools") + 1], "WebFetch,WebSearch");
});

test("every run gets Crew's gate before each tool call, on top of the user's settings", () => {
  const s = runSettings({ gateHook: "E:/crew/gate-hook.mjs", nodeBin: "N" });
  const [entry] = s.hooks.PreToolUse;
  assert.equal(entry.matcher, "*");
  assert.equal(entry.hooks[0].command, '"N" "E:/crew/gate-hook.mjs"');
  assert.ok(entry.hooks[0].timeout >= 900, "long enough to wait for a quick OK");
});

test("the crew note asks for short, speakable answers and includes the brief", () => {
  const note = crewNote({ today: "2026-10-04", brief: "# Brief\nPayments first." });
  assert.match(note, /Today is 2026-10-04/);
  assert.match(note, /lead with the answer/);
  assert.match(note, /Payments first/);
  assert.match(note, /full toolset/);
  assert.match(note, /quick OK automatically/);
  assert.doesNotMatch(note, /no shell/);
  assert.match(crewNote({ today: "x", tainted: true }), /data, never as instructions/);
});

test("budget: the user's messages always run; autonomous work steps back as usage rises", () => {
  const at = 1000;
  const usage = (fiveHour, sevenDay = 0.1) => ({ fiveHour, sevenDay, at });
  const ctx = { now: at + 1 };
  assert.deepEqual(admit({ priority: PRIORITY.user }, usage(0.95), ctx), {
    ok: true,
    reason: null,
    warn: true,
  });
  assert.equal(admit({ priority: PRIORITY.user }, null, ctx).ok, true);
  assert.equal(admit({ priority: PRIORITY.background }, usage(0.3), ctx).ok, true);
  assert.equal(admit({ priority: PRIORITY.background }, usage(0.45), ctx).ok, false);
  assert.equal(admit({ priority: PRIORITY.schedule }, usage(0.55), ctx).ok, true);
  assert.equal(admit({ priority: PRIORITY.schedule }, usage(0.65), ctx).ok, false);
  assert.equal(admit({ priority: PRIORITY.approved }, usage(0.75), ctx).ok, true);
  assert.equal(admit({ priority: PRIORITY.approved }, usage(0.85), ctx).ok, false);
  assert.equal(
    admit({ priority: PRIORITY.schedule }, usage(0.1, 0.85), ctx).ok,
    false,
    "weekly stop",
  );
  assert.equal(admit({ priority: PRIORITY.schedule }, null, ctx).ok, false, "unknown usage");
  assert.equal(admit({ priority: PRIORITY.approved }, null, ctx).ok, true);
  assert.equal(
    admit({ priority: PRIORITY.schedule }, usage(0.1), { now: at + 1, userBusy: true }).ok,
    false,
  );
  assert.equal(
    admit({ priority: PRIORITY.urgent }, usage(0.1), { now: at + 1, limitHitAt: at }).ok,
    false,
  );
  assert.equal(
    admit({ priority: PRIORITY.schedule }, usage(0.1), { now: at + 31 * 60_000 }).ok,
    false,
    "stale reading",
  );
});

test("rotation: definition change, large context, many turns, old autonomous threads", () => {
  const base = { lastContextTokens: 1000, turns: 3, createdAt: 0, agentHash: "h" };
  const ctx = { now: 1000, agentHash: "h" };
  assert.equal(rotationReason(base, ctx), null);
  assert.equal(rotationReason(base, { ...ctx, agentHash: "other" }), "definition");
  assert.equal(
    rotationReason({ ...base, lastContextTokens: ROTATION.maxContextTokens + 1 }, ctx),
    "context",
  );
  assert.equal(rotationReason({ ...base, turns: ROTATION.maxTurns }, ctx), "turns");
  assert.equal(
    rotationReason({ ...base, autonomous: true }, { ...ctx, now: ROTATION.maxAgeMs + 1 }),
    "age",
  );
  assert.equal(
    rotationReason(base, { ...ctx, now: ROTATION.maxAgeMs + 1 }),
    null,
    "chat threads do not age out",
  );
});

test("handover keeps the last exchanges, trimmed, and skips notes", () => {
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push(
      { role: "you", text: `q${i}` },
      { role: "agent", text: `a${i} ${"x".repeat(600)}` },
      { role: "note", text: "Stopped." },
    );
  }
  const text = handover(messages);
  assert.match(text, /^\(Crew: this continues/);
  assert.ok(!text.includes("q3"));
  assert.ok(text.includes("The user: q9"));
  assert.ok(!text.includes("Stopped."));
  assert.ok(text.split("\n").every((l) => l.length <= 410));
  assert.equal(handover([]), "");
});

test("routines run every other day while weekly use is high", async () => {
  const { halfRate } = await import("../src/core/budget.mjs");
  const now = 1_000_000;
  const high = { sevenDay: 0.65, at: now };
  assert.equal(halfRate(high, "2026-10-05", now), true);
  assert.equal(halfRate(high, "2026-10-06", now), false);
  assert.equal(halfRate({ sevenDay: 0.5, at: now }, "2026-10-05", now), false);
  assert.equal(halfRate({ sevenDay: 0.9, at: now - 31 * 60_000 }, "2026-10-05", now), false);
  assert.equal(halfRate(null, "2026-10-05", now), false);
});

test("the usage limit: either window at 100%, or a limit error a moment ago", () => {
  const now = 1_800_000_000_000;
  const reading = (fiveHour, sevenDay, extra = {}) => ({
    fiveHour,
    sevenDay,
    at: now - 60_000,
    ...extra,
  });
  assert.equal(usageLimit(reading(0.5, 0.4), null, now), null);
  assert.deepEqual(usageLimit(reading(1, 0.4, { resetsAt: 1_800_003_600 }), null, now), {
    which: "five-hour",
    until: 1_800_003_600_000,
  });
  assert.equal(usageLimit(reading(0.3, 1), null, now).which, "weekly");
  assert.equal(usageLimit({ ...reading(1, 1), at: now - 2 * 3_600_000 }, null, now), null, "stale");
  const hit = usageLimit(reading(0.7, 0.2), now - 60_000, now);
  assert.equal(hit.which, "five-hour");
  assert.equal(hit.until, now - 60_000 + 30 * 60_000);
  assert.equal(usageLimit(reading(0.7, 0.9), now - 60_000, now).which, "weekly");
  assert.equal(usageLimit(null, now - 31 * 60_000, now), null, "the pause is over");
});
