// "Tell it now" notes and the checklist: the hub side, the run settings, and the tweak hook.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { runTurn, killTree } from "../src/io/claude.mjs";
import { testConfig } from "./team-config.mjs";
import { runSettings } from "../src/core/policy.mjs";
import { cleanSteps, tweakContext } from "../src/core/tweaks.mjs";

const HOOK = fileURLToPath(new URL("../src/io/tweak-hook.mjs", import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "crew-tweaks-"));
  const brain = join(root, "brain");
  const agentsDir = join(root, "agents");
  const runs = join(root, "runs");
  for (const dir of [brain, agentsDir, runs]) mkdirSync(dir, { recursive: true });
  for (const a of ["ceo", "social"]) {
    writeFileSync(join(agentsDir, `${a}.md`), `---\nname: ${a}\n---\n\nYou are ${a}.\n`);
  }
  const store = new Store(":memory:");
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain, agentsDir, runs, crewGuard: "g", gateHook: "g" },
    bin: "none",
    runTurn,
    sessions: () => [],
    killTree,
    afterWrite: () => {},
  });
  hub.stop(); // nothing runs: a run in progress is staged by hand
  const working = (agent) => {
    const job = store.addJob({
      agent,
      kind: "chat",
      priority: 0,
      prompt: "make the video",
      createdAt: 1,
    });
    store.updateJob(job.id, { status: "running" });
    hub.running.set(job.id, { agent, kind: "chat", kill: () => {} });
    return job;
  };
  const done = () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { store, hub, working, done };
}

test("a note sent now goes to the run in progress, and the chat says when it was read", () => {
  const { store, hub, working, done } = setup();
  try {
    const job = working("social");
    const answer = hub.tweak("social", "make it 30 seconds, not 60");
    assert.equal(answer.now, true);
    assert.equal(answer.job.id, job.id);
    assert.equal(store.queuedJobs().length, 0, "not queued as a new task");
    assert.deepEqual(
      hub.messages("social").map((m) => [m.role, m.text]),
      [["you", "make it 30 seconds, not 60"]],
    );

    assert.deepEqual(hub.takeTweaks(job.id).texts, ["make it 30 seconds, not 60"]);
    assert.deepEqual(hub.takeTweaks(job.id).texts, [], "handed over once");
    assert.match(hub.messages("social").pop().text, /got your note mid-task/);
  } finally {
    done();
  }
});

test("with nothing in progress a note is an ordinary message", () => {
  const { store, hub, done } = setup();
  try {
    const answer = hub.tweak("social", "hello");
    assert.equal(answer.now, false);
    assert.equal(store.queuedJobs()[0].prompt, "hello");
  } finally {
    done();
  }
});

test("the checklist shows on the agent while its run is in progress", () => {
  const { hub, working, done } = setup();
  try {
    const job = working("social");
    hub.setProgress(job.id, [
      { text: "Carousel", status: "done" },
      { text: "Video", status: "doing" },
      "Post",
    ]);
    const social = hub.agents().find((a) => a.id === "social");
    assert.deepEqual(
      social.progress.map((s) => s.status),
      ["done", "doing", "todo"],
    );
    assert.throws(() => hub.setProgress(999, ["x"]), /run in progress/);
    assert.throws(() => cleanSteps([]), /as a list/);
    assert.equal(cleanSteps(Array.from({ length: 20 }, (_, i) => `s${i}`)).length, 12);
  } finally {
    done();
  }
});

test("runs carry the tweak hook after every step and at the end", () => {
  const settings = runSettings({ gateHook: "G", tweakHook: "T", nodeBin: "N" });
  assert.match(settings.hooks.PostToolUse[0].hooks[0].command, /"T"$/);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /"T"$/);
  assert.equal(runSettings({ gateHook: "G" }).hooks.PostToolUse, undefined);
  assert.match(tweakContext(["shorter"], "Fahim"), /Fahim sent you this[\s\S]*- shorter/);
});

/** A stand-in hub that hands out one note, then none. */
async function fakeHub(texts) {
  let left = [...texts];
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ texts: left }));
    left = [];
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

/** Run the hook as Claude Code does: the event on stdin, the answer on stdout. */
async function runHook(port, input, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crew-hook-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "t");
  const child = spawn(process.execPath, [HOOK], {
    env: {
      ...process.env,
      CREW_JOB: "7",
      CREW_PORT: String(port),
      CREW_TOKEN_FILE: tokenFile,
      CREW_OWNER: "Fahim",
      ...extraEnv,
    },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.end(JSON.stringify(input));
  await new Promise((r) => child.on("close", r));
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test("the hook hands a note over after a step, keeps the agent going at the end, and is quiet otherwise", async () => {
  const server = await fakeHub(["use the blue logo"]);
  const port = server.address().port;
  try {
    const after = JSON.parse(await runHook(port, { hook_event_name: "PostToolUse" }));
    assert.equal(after.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(after.hookSpecificOutput.additionalContext, /use the blue logo/);
    assert.equal(await runHook(port, { hook_event_name: "PostToolUse" }), "", "nothing left");
  } finally {
    server.close();
  }
  const end = await fakeHub(["also tag Sam"]);
  try {
    const stop = JSON.parse(await runHook(end.address().port, { hook_event_name: "Stop" }));
    assert.equal(stop.decision, "block");
    assert.match(stop.reason, /also tag Sam/);
    // A subagent's steps don't take the user's notes.
    assert.equal(
      await runHook(end.address().port, { hook_event_name: "PostToolUse", agent_id: "a1" }),
      "",
    );
  } finally {
    end.close();
  }
});

test("a skill review after a task runs quietly and takes no notes", () => {
  const { store, hub, done } = setup();
  try {
    const task = store.addJob({
      agent: "social",
      kind: "chat",
      priority: 0,
      prompt: "x",
      createdAt: 1,
    });
    store.updateJob(task.id, { status: "done", endedAt: Date.now() });
    const review = store.addJob({
      agent: "social",
      kind: "review",
      priority: 2,
      prompt: "r",
      createdAt: 2,
    });
    store.updateJob(review.id, { status: "running" });
    hub.running.set(review.id, { agent: "social", kind: "review", kill: () => {} });
    assert.equal(hub.agents().find((a) => a.id === "social").state, "done");
    const answer = hub.tweak("social", "the one before it");
    assert.equal(answer.now, false, "a new message, not a note to the review");
  } finally {
    done();
  }
});

test("a note that arrives after the task ended says so in the chat", () => {
  const { hub, done } = setup();
  try {
    hub.tweak("social", "does X punish links?");
    const [you, note] = hub.messages("social");
    assert.equal(you.role, "you");
    assert.match(note.text, /had already finished, so this went in as a new message/);
  } finally {
    done();
  }
});

test("a running task still shows as working while more messages wait behind it", () => {
  const { store, hub, working, done } = setup();
  try {
    working("social");
    hub.send("social", "by the way, are you recording in the real terminal?");
    const social = hub.agents().find((a) => a.id === "social");
    assert.equal(social.state, "working");
    assert.equal(social.queued, 1);
    assert.equal(store.queuedJobs().length, 1);
  } finally {
    done();
  }
});
