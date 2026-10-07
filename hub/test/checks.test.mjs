// Checks agents schedule for themselves: timing rules, the queue, results and cancelling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { runTurn, killTree } from "../src/io/claude.mjs";
import { testConfig } from "./team-config.mjs";
import {
  allFine,
  checkPrompt,
  checksNote,
  duration,
  finished,
  nextRun,
  parseWhen,
  planCheck,
} from "../src/core/checks.mjs";
import { pushFor } from "../src/core/push.mjs";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const H = 3_600_000;
const DAY = 24 * H;
// 2026-10-07 12:00 UTC; the user is at UTC+6.
const NOW = Date.UTC(2026, 9, 7, 12, 0);
const OFF = 360;

test("when: in 2h, a local time in the user's zone, or an exact time", () => {
  assert.equal(duration("90m"), 90 * 60_000);
  assert.equal(duration("3 days"), 3 * DAY);
  assert.equal(duration("soon"), null);
  assert.equal(parseWhen("in 2h", NOW, OFF), NOW + 2 * H);
  // 08:00 tomorrow in UTC+6 is 02:00 UTC.
  assert.equal(parseWhen("2026-10-08 08:00", NOW, OFF), Date.UTC(2026, 9, 8, 2, 0));
  assert.equal(parseWhen("2026-10-08T08:00:00Z", NOW, OFF), Date.UTC(2026, 9, 8, 8, 0));
  assert.equal(parseWhen("tomorrow-ish", NOW, OFF), null);
});

test("timing: once, or repeating until an end within 30 days, at most hourly", () => {
  assert.deepEqual(planCheck({ when: "in 2h" }, NOW, OFF), {
    at: NOW + 2 * H,
    every: null,
    until: null,
  });
  const repeat = planCheck({ when: "in 1h", every: "3h", until: "in 2 days" }, NOW, OFF);
  assert.equal(repeat.every, 3 * H);
  assert.throws(
    () => planCheck({ when: "in 1h", every: "30m", until: "in 1 day" }, NOW, OFF),
    /once an hour/,
  );
  assert.throws(() => planCheck({ when: "in 1h", every: "3h" }, NOW, OFF), /needs `until`/);
  assert.throws(
    () => planCheck({ when: "in 1h", every: "1 day", until: "in 40 days" }, NOW, OFF),
    /30 days/,
  );
  assert.throws(() => planCheck({ when: "2026-01-01 08:00" }, NOW, OFF), /already passed/);
  assert.throws(() => planCheck({ when: "in 90 days" }, NOW, OFF), /60 days/);
  assert.throws(() => planCheck({ when: "whenever" }, NOW, OFF), /say when/);
  assert.equal(nextRun({ at: NOW, every: 3 * H, until: NOW + 5 * H }), NOW + 3 * H);
  assert.equal(nextRun({ at: NOW + 3 * H, every: 3 * H, until: NOW + 5 * H }), null);
});

test("replies: all fine stays quiet, and a repeating check can say it is finished", () => {
  assert.equal(allFine("All fine: the booking is still on."), true);
  assert.equal(allFine("The booking was cancelled at 07:10."), false);
  assert.equal(finished("Reply came in. Check finished"), true);
  const prompt = checkPrompt({
    check: {
      what: "See whether the Pathao booking for 10:00 was cancelled.",
      why: "Cab tomorrow",
      every: null,
      runs: 0,
    },
    owner: "Fahim",
    when: "2026-10-07",
  });
  assert.match(prompt, /Pathao booking/);
  assert.match(prompt, /All fine:/);
  assert.match(checksNote(), /schedule_check/);
});

test("a check that found something reaches the phone", () => {
  const push = pushFor({
    type: "check.found",
    data: { agent: "ops", text: "The booking was cancelled." },
  });
  assert.equal(push.title, "Ops checked something");
  assert.equal(push.urgent, true);
  assert.equal(push.data.k, "thread");
});

/** A hub over a temp brain that never starts a run: these tests look at the queue only. */
function setup(now) {
  const root = mkdtempSync(join(tmpdir(), "crew-checks-"));
  const brain = join(root, "brain");
  const agentsDir = join(root, "agents");
  const runs = join(root, "runs");
  for (const dir of [brain, agentsDir, runs]) mkdirSync(dir, { recursive: true });
  for (const a of ["ceo", "social", "ops"]) {
    writeFileSync(
      join(agentsDir, `${a}.md`),
      `---\nname: ${a}\ndescription: ${a}\n---\n\nYou are ${a}.\n`,
    );
  }
  const store = new Store(":memory:");
  const notes = [];
  const hub = new Hub({
    config: { ...testConfig(), quiet: [] },
    store,
    paths: { brain, agentsDir, runs, crewGuard: "guard.mjs", gateHook: "gate-hook.mjs" },
    bin: FAKE,
    runTurn,
    sessions: () => [],
    killTree,
    afterWrite: () => {},
    now: () => now.value,
    utcOffsetMinutes: () => OFF,
    notify: (n) => notes.push(n),
  });
  hub.stop();
  const running = (agent) => {
    const job = store.addJob({ agent, kind: "chat", priority: 0, prompt: "x", createdAt: NOW });
    store.updateJob(job.id, { status: "running" });
    return job;
  };
  const done = () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { store, hub, notes, running, done };
}

test("only a running job schedules; the hub queues it when due and keeps its rhythm", () => {
  const now = { value: NOW };
  const { store, hub, running, done } = setup(now);
  try {
    const idle = store.addJob({
      agent: "ops",
      kind: "chat",
      priority: 0,
      prompt: "x",
      createdAt: NOW,
    });
    assert.throws(
      () => hub.addCheck({ jobId: idle.id, when: "in 1h", what: "x" }),
      /run in progress/,
    );
    const job = running("ops");
    const once = hub.addCheck({
      jobId: job.id,
      when: "in 2h",
      what: "See whether the 10:00 cab was cancelled.",
      why: "Cab tomorrow",
    });
    const repeat = hub.addCheck({
      jobId: job.id,
      when: "in 1h",
      every: "3h",
      until: "in 8h",
      what: "Has the client replied? If so, say Check finished.",
    });
    assert.equal(hub.checks("ops").length, 2);
    const checkJobs = () => store.queuedJobs().filter((j) => j.kind === "check");

    hub.checksTick();
    assert.equal(checkJobs().length, 0, "nothing due yet");

    // 1h later: the repeating one runs and moves on to +4h.
    now.value = NOW + H;
    hub.checksTick();
    assert.equal(checkJobs().length, 1);
    assert.match(checkJobs()[0].prompt, /Has the client replied/);
    assert.equal(hub.checks("ops").find((c) => c.id === repeat.id).at, NOW + 4 * H);

    // The PC was off until +7h: each due check runs once. The repeating one's late run covers
    // the slots it missed and is its last before the end (+8h).
    now.value = NOW + 7 * H;
    hub.checksTick();
    assert.equal(checkJobs().length, 3);
    assert.equal(hub.checks("ops").find((c) => c.id === once.id).status, "done");
    assert.equal(hub.checks("ops").find((c) => c.id === repeat.id).status, "done");

    // The user cancels one that is still open.
    const later = hub.addCheck({ jobId: job.id, when: "in 2 days", what: "Look again." });
    hub.cancelCheck(later.id);
    assert.equal(hub.checks("ops").find((c) => c.id === later.id).status, "cancelled");
  } finally {
    done();
  }
});

test("at most 10 open checks per agent", () => {
  const now = { value: NOW };
  const { hub, running, done } = setup(now);
  try {
    const job = running("social");
    for (let i = 0; i < 10; i++) {
      hub.addCheck({ jobId: job.id, when: `in ${i + 1}h`, what: `check ${i}` });
    }
    assert.throws(
      () => hub.addCheck({ jobId: job.id, when: "in 20h", what: "one more" }),
      /10 open checks/,
    );
  } finally {
    done();
  }
});

test("a check result: something found notifies; Check finished stops a repeating one", () => {
  const now = { value: NOW };
  const { store, hub, notes, running, done } = setup(now);
  try {
    const job = running("ops");
    const c = hub.addCheck({
      jobId: job.id,
      when: "in 1h",
      every: "3h",
      until: "in 2 days",
      what: "Has the client replied?",
    });
    now.value = NOW + H;
    hub.checksTick();
    const run = store.queuedJobs().find((j) => j.kind === "check");

    hub.checkRan(run, "All fine: nothing yet.", true);
    assert.equal(notes.length, 0, "all fine stays quiet");
    assert.equal(hub.checks("ops").find((x) => x.id === c.id).status, "active");

    hub.checkRan(run, "The client replied: they want Friday. Check finished", false);
    assert.equal(notes.at(-1).title, "Ops checked something");
    assert.equal(hub.checks("ops").find((x) => x.id === c.id).status, "cancelled");
  } finally {
    done();
  }
});
