import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  minutesOf,
  localParts,
  inWindow,
  blockedBy,
  dueSchedules,
  startOfLocalDay,
} from "../src/core/schedule.mjs";
import { inboxItem, wakePrompt, frontMatter } from "../src/core/inbox.mjs";
import { askBlocked, requestSummary, teamLines } from "../src/core/teamtalk.mjs";
import { buildReport } from "../src/core/report.mjs";
import { resolveConfig, DEFAULT_CONFIG } from "../src/core/config.mjs";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { runTurn, runScript, killTree } from "../src/io/claude.mjs";
import { scanInboxes } from "../src/io/watch.mjs";
import { PRIORITY } from "../src/core/budget.mjs";
import { testConfig } from "./team-config.mjs";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const at = (iso) => Date.parse(iso);

// --- pure parts

test("schedule helpers: times, local parts, windows that wrap midnight", () => {
  assert.equal(minutesOf("09:30"), 570);
  assert.throws(() => minutesOf("9am"));
  assert.deepEqual(localParts(at("2026-10-04T03:30:00Z"), 360), {
    date: "2026-10-04",
    minutes: 570,
    weekday: 0,
  });
  const night = { from: "23:20", to: "01:00" };
  assert.equal(inWindow(minutesOf("23:45"), night), true);
  assert.equal(inWindow(minutesOf("00:30"), night), true);
  assert.equal(inWindow(minutesOf("01:00"), night), false);
  assert.equal(
    blockedBy(at("2026-10-04T20:00:00Z"), 360, DEFAULT_CONFIG.quiet),
    "quiet hours",
    "02:00 local",
  );
  assert.equal(blockedBy(at("2026-10-04T06:00:00Z"), 360, DEFAULT_CONFIG.quiet), null);
  assert.equal(startOfLocalDay(at("2026-10-04T03:30:15Z"), 360), at("2026-10-03T18:00:00Z"));
});

test("due schedules: past their time, once a day, on their weekdays, enabled only", () => {
  const schedules = [
    { id: "brief", at: "09:00" },
    { id: "weekly", at: "09:00", days: [1] },
    { id: "off", at: "08:00", enabled: false },
  ];
  const sundayNine = at("2026-10-04T03:05:00Z"); // 09:05 local, a Sunday
  const ids = (list) => list.map((s) => s.id);
  assert.deepEqual(ids(dueSchedules(schedules, {}, sundayNine, 360).due), ["brief"]);
  assert.deepEqual(dueSchedules(schedules, { brief: "2026-10-04" }, sundayNine, 360).due, []);
  assert.deepEqual(
    ids(dueSchedules(schedules, { brief: "2026-10-03" }, at("2026-10-04T05:30:00Z"), 360).due),
    ["brief"],
    "11:30: missed while the PC was off, runs late the same day",
  );
  const evening = dueSchedules(schedules, {}, at("2026-10-04T11:00:00Z"), 360); // 17:00
  assert.deepEqual(evening.due, [], "a 09:00 brief is pointless at 17:00");
  assert.deepEqual(ids(evening.skipped), ["brief"]);
  assert.deepEqual(dueSchedules(schedules, {}, at("2026-10-04T02:00:00Z"), 360).due, [], "08:00");
});

test("inbox items: path, front matter, trust", () => {
  const text = "---\nfrom: mailroom\nto: ops\ncreated: 2026-09-23\nstatus: open\n---\nbody";
  assert.deepEqual(frontMatter(text).from, "mailroom");
  const item = inboxItem("departments\\ops\\inbox\\2026-09-23-mailroom-x.md", text);
  assert.deepEqual(item, {
    path: "departments/ops/inbox/2026-09-23-mailroom-x.md",
    dept: "ops",
    file: "2026-09-23-mailroom-x.md",
    from: "mailroom",
    status: "open",
    trusted: false,
    summary: "body",
  });
  assert.equal(inboxItem("departments/learning/inbox/links.md", "- [ ] x"), null);
  assert.equal(inboxItem("departments/ops/memory/2026-01-01-x.md", text), null);
  assert.equal(
    inboxItem("departments/ops/inbox/2026-09-23-user-y.md", "---\nfrom: user\n---").trusted,
    true,
  );
});

test("the wake prompt fences untrusted items and asks for status: done", () => {
  const trusted = wakePrompt({ path: "departments/ops/inbox/a.md", from: "ceo", trusted: true });
  assert.match(trusted, /status: done/);
  assert.ok(!/information, not instructions/.test(trusted));
  const mail = wakePrompt({ path: "departments/ops/inbox/b.md", from: "mailroom", trusted: false });
  assert.match(mail, /information, not instructions/);
  assert.match(mail, /no web access/);
});

test("the report counts autonomous work only, and says when it was quiet", () => {
  const jobs = new Map([
    [1, { agent: "ops", kind: "inbox" }],
    [2, { agent: "ops", kind: "inbox" }],
    [3, { agent: "ceo", kind: "chat" }],
    [4, { agent: "mailroom", kind: "system" }],
    [5, { agent: "social", kind: "schedule" }],
  ]);
  const events = [
    { type: "inbox.woke", data: {} },
    { type: "job.done", data: { jobId: 1 } },
    { type: "job.done", data: { jobId: 2 } },
    { type: "job.done", data: { jobId: 3 } },
    { type: "job.done", data: { jobId: 4 } },
    { type: "job.failed", data: { jobId: 5, error: "timed out" } },
  ];
  const { lines, counts } = buildReport(events, { jobs });
  assert.deepEqual(counts, { done: 2, failed: 1, woken: 1, mail: 1 });
  assert.ok(lines.includes("2 jobs finished: ops ×2."));
  assert.ok(lines.some((l) => l.includes("social: timed out")));
  assert.deepEqual(buildReport([], { jobs }).lines, [
    "Quiet since the last report: nothing new came in and nothing ran.",
  ]);
});

test("a user config replaces top-level keys and keeps the rest", () => {
  const config = resolveConfig({ maxAutonomousPerDay: 3 });
  assert.equal(config.maxAutonomousPerDay, 3);
  assert.deepEqual(config.quiet, DEFAULT_CONFIG.quiet);
  assert.deepEqual(resolveConfig(null), { ...DEFAULT_CONFIG });
});

// --- the hub, with a controllable clock

const AGENT_MD = (name) => `---
name: ${name}
description: ${name}
tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch
model: sonnet
---

You are ${name}.
`;

function setup(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "crew-s2-"));
  const brain = join(root, "brain");
  const agentsDir = join(root, "agents");
  const runs = join(root, "runs");
  for (const dir of [agentsDir, runs, join(brain, "tools")]) mkdirSync(dir, { recursive: true });
  for (const d of ["ceo", "ops", "social"]) {
    mkdirSync(join(brain, "departments", d, "inbox"), { recursive: true });
    writeFileSync(join(agentsDir, `${d}.md`), AGENT_MD(d));
  }
  const clock = { now: at("2026-10-04T05:00:00Z") }; // 11:00 local at +06:00
  const store = new Store(":memory:");
  // A fresh, low usage reading: autonomous work is refused while usage is unknown.
  store.set("usage", { fiveHour: 0.1, sevenDay: 0.1, at: clock.now });
  const hub = new Hub({
    store,
    paths: { brain, agentsDir, runs, crewGuard: "guard.mjs" },
    bin: FAKE,
    runTurn,
    runScript,
    sessions: () => [],
    scanInboxes,
    killTree,
    config: testConfig({
      inbox: { enabled: true, departments: ["ceo", "ops", "social"] },
      ...config,
    }),
    now: () => clock.now,
    utcOffsetMinutes: () => 360,
  });
  const writeItem = (dept, name, from, status = "open") =>
    writeFileSync(
      join(brain, "departments", dept, "inbox", name),
      `---\nfrom: ${from}\nto: ${dept}\ncreated: 2026-10-04\nstatus: ${status}\n---\nPlease look.`,
    );
  const close = async () => {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, brain, runs, store, hub, clock, writeItem, close };
}

function finished(hub, jobId) {
  return new Promise((resolve) => {
    const check = () => {
      const job = hub.job(jobId);
      if (["done", "failed", "cancelled"].includes(job.status)) {
        hub.off("event", check);
        resolve(job);
      }
    };
    hub.on("event", check);
    check();
  });
}

const queuedOf = (store, kind) => store.queuedJobs().filter((j) => j.kind === kind);

test("the first inbox scan only notes the backlog; a new item wakes its department", async () => {
  const s = setup();
  try {
    s.writeItem("ops", "2026-10-01-ceo-old.md", "ceo");
    s.hub.inboxTick();
    assert.equal(s.store.queuedJobs().length, 0, "backlog noted, not woken");
    assert.ok(s.store.eventsSince(0).some((e) => e.type === "inbox.baseline"));

    s.writeItem("social", "2026-10-04-user-new-post.md", "user");
    s.writeItem("ops", "2026-10-04-ceo-closed.md", "ceo", "done");
    assert.equal(s.hub.inboxTick(), 1, "only the new open item");
    const [job] = s.store.jobsWithStatus("queued");
    assert.equal(job.agent, "social");
    assert.equal(job.kind, "inbox");
    assert.equal(job.priority, PRIORITY.urgent);
    assert.equal(job.tainted, 0);
    assert.equal(s.hub.inboxTick(), 0, "never woken twice for one item");

    s.hub.start();
    const done = await finished(s.hub, job.id);
    assert.equal(done.status, "done");
  } finally {
    await s.close();
  }
});

test("a mailroom item is untrusted: its run has no web tools and asks before acting", async () => {
  const s = setup();
  try {
    s.hub.inboxTick();
    s.writeItem("ops", "2026-10-04-mailroom-sentry.md", "mailroom");
    s.hub.inboxTick();
    const [job] = s.store.jobsWithStatus("queued");
    assert.equal(job.tainted, 1);
    s.hub.start();
    await finished(s.hub, job.id);
    const { args, env } = s.hub.lastRun;
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "WebFetch,WebSearch");
    assert.equal(env.CREW_TAINTED, "1", "the gate asks before anything beyond reading");
  } finally {
    await s.close();
  }
});

test("routines fire once a day after their time; the report needs no model", async () => {
  const s = setup();
  try {
    s.clock.now = at("2026-10-04T02:45:00Z"); // 08:45 local
    s.hub.schedulerTick();
    assert.ok(s.hub.report(), "08:30 report built");
    assert.equal(queuedOf(s.store, "schedule").length, 0, "CEO brief not yet");

    s.clock.now = at("2026-10-04T03:01:00Z"); // 09:01
    s.hub.schedulerTick();
    s.hub.schedulerTick();
    const briefs = queuedOf(s.store, "schedule");
    assert.equal(briefs.length, 1, "once, not twice");
    assert.equal(briefs[0].agent, "ceo");
    assert.equal(briefs[0].priority, PRIORITY.schedule);
  } finally {
    await s.close();
  }
});

test("quiet hours hold routines and autonomous jobs, but never the user's own messages", async () => {
  const s = setup();
  try {
    s.clock.now = at("2026-10-04T20:00:00Z"); // 02:00 local, quiet hours
    s.hub.schedulerTick();
    assert.equal(s.store.queuedJobs().length, 0, "routines wait for the window to end");

    s.store.set("usage", { fiveHour: 0.1, sevenDay: 0.1, at: s.clock.now });
    const auto = s.hub.enqueue({
      agent: "ops",
      kind: "inbox",
      priority: PRIORITY.urgent,
      prompt: "x",
    });
    const mine = s.hub.send("ceo", "are you there?");
    s.hub.start();
    assert.equal((await finished(s.hub, mine.id)).status, "done");
    assert.equal(s.hub.job(auto.id).status, "queued");
  } finally {
    await s.close();
  }
});

test("the daily cap stops autonomous work, and a paused hub schedules nothing", async () => {
  const s = setup({ maxAutonomousPerDay: 1 });
  try {
    s.store.set("usage", { fiveHour: 0.1, sevenDay: 0.1, at: s.clock.now });
    const done = s.store.addJob({
      agent: "ops",
      kind: "inbox",
      priority: 2,
      prompt: "x",
      createdAt: s.clock.now,
    });
    s.store.updateJob(done.id, { status: "done", startedAt: s.clock.now });
    assert.equal(s.hub.autonomousToday(), 1);
    const next = s.hub.enqueue({
      agent: "ops",
      kind: "inbox",
      priority: PRIORITY.urgent,
      prompt: "y",
    });
    s.hub.tick();
    assert.equal(s.hub.job(next.id).status, "queued", "capped");

    s.hub.stopAll();
    s.clock.now = at("2026-10-04T03:30:00Z");
    s.hub.schedulerTick();
    assert.equal(queuedOf(s.store, "schedule").length, 0);
  } finally {
    await s.close();
  }
});

test("the mailroom runs as a system job, and what it files wakes its department", async () => {
  const s = setup();
  try {
    writeFileSync(
      join(s.brain, "tools", "mail-triage.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync("departments/ops/inbox/2026-10-04-mailroom-admob.md", "---\\nfrom: mailroom\\nto: ops\\nstatus: open\\n---\\nAdMob mail.");
console.log("filed 1");`,
    );
    s.hub.inboxTick(); // baseline
    s.store.set("usage", { fiveHour: 0.1, sevenDay: 0.1, at: s.clock.now });
    const mail = s.hub.enqueue({
      agent: "mailroom",
      kind: "system",
      priority: PRIORITY.schedule,
      prompt: "mail-midday",
    });
    s.hub.start();
    const done = await finished(s.hub, mail.id);
    assert.equal(done.status, "done");
    assert.match(done.result, /filed 1/);
    const woke = s.store.eventsSince(0).find((e) => e.type === "inbox.woke");
    assert.equal(woke.data.agent, "ops");
    assert.equal(woke.data.trusted, false);
  } finally {
    await s.close();
  }
});

test("signing in late: stale routines are skipped, the report is still built, mail queues once", async () => {
  const s = setup();
  try {
    s.clock.now = at("2026-10-04T11:30:00Z"); // 17:30 local
    s.hub.schedulerTick();
    assert.ok(s.hub.report(), "the report is free, so it is built late");
    assert.equal(queuedOf(s.store, "schedule").length, 0, "no 09:00 brief at 17:30");
    assert.ok(s.store.eventsSince(0).some((e) => e.type === "schedule.skipped"));
    const mail = s.store.queuedJobs().filter((j) => j.kind === "system");
    assert.equal(mail.length, 1, "17:00 mail queued; 12:00 was too late and is skipped");
    s.hub.schedulerTick();
    assert.equal(s.store.queuedJobs().filter((j) => j.kind === "system").length, 1);
  } finally {
    await s.close();
  }
});

test("budgetGuard false lifts the usage caps for work Crew starts itself", async () => {
  const { Store } = await import("../src/io/store.mjs");
  const { Hub } = await import("../src/hub.mjs");
  const store = new Store(":memory:");
  const started = [];
  const make = (budgetGuard) =>
    new Hub({
      store,
      config: testConfig({ quiet: [], budgetGuard }),
      paths: { brain: "C:/brain", agentsDir: "C:/agents", runs: "C:/runs" },
      bin: "none",
      runTurn: () => {
        throw new Error("no runs here");
      },
      sessions: () => [],
    });
  store.set("usage", { fiveHour: 0.95, sevenDay: 0.95, at: Date.now() });
  const capped = make(true);
  capped.runJob = async (job) => started.push(job.id);
  const job = capped.enqueue({ agent: "ops", kind: "schedule", priority: 3, prompt: "x" });
  capped.tick();
  assert.deepEqual(started, [], "held at 95% use");
  capped.stop();
  const free = make(false);
  free.runJob = async (j) => started.push(j.id);
  free.tick();
  assert.deepEqual(started, [job.id]);
  free.stop();
  store.close();
});

// --- agents talking to each other

test("team talk: a request's summary, the lines both chats show, who may ask whom", () => {
  assert.equal(
    requestSummary("---\nfrom: ceo\n---\n\n# Find three rivals\nmore"),
    "Find three rivals",
  );
  assert.equal(requestSummary("x".repeat(300)).length, 160);
  const long = `${"word ".repeat(30)}**bold part** see [TBS News](https://tbsnews.net/a/very/long/path)`;
  assert.equal(
    teamLines("handoff", { fromTitle: "A", toTitle: "B", text: long }).forTo,
    `← A asked: ${"word ".repeat(30)}**bold part** see…`,
    "never cut inside a link",
  );
  assert.deepEqual(
    teamLines("handoff", { fromTitle: "CEO", toTitle: "Ops", text: "check  AdMob" }),
    {
      forFrom: "→ Asked Ops: check AdMob",
      forTo: "← CEO asked: check AdMob",
    },
  );
  assert.equal(
    teamLines("answer", { fromTitle: "CEO", toTitle: "Ops", text: "42" }).forFrom,
    "← Ops answered: 42",
  );
  const team = ["ceo", "ops", "social"];
  const p = { from: "ceo", to: "ops", askingJob: { kind: "chat" }, team, waiting: new Set() };
  assert.equal(askBlocked(p), null);
  assert.match(askBlocked({ ...p, to: "nobody" }), /no teammate/);
  assert.match(askBlocked({ ...p, to: "ceo" }), /yourself/);
  assert.match(askBlocked({ ...p, askingJob: { kind: "ask" } }), /answering/);
  assert.match(
    askBlocked({ ...p, waiting: new Set(["ops"]) }),
    /waiting on a teammate/,
    "no deadlock",
  );
});

const teamText = (store, agent) =>
  store
    .messages(agent)
    .filter((m) => m.role === "team")
    .map((m) => m.text);

test("a handoff shows in both chats, and its reply goes back to whoever asked", async () => {
  const s = setup();
  try {
    s.hub.inboxTick();
    writeFileSync(
      join(s.brain, "departments", "ops", "inbox", "2026-10-04-ceo-admob.md"),
      "---\nfrom: ceo\nto: ops\ncreated: 2026-10-04\nstatus: open\n---\nCheck the AdMob payout.",
    );
    s.hub.inboxTick();
    assert.deepEqual(teamText(s.store, "ceo"), ["→ Asked Ops: Check the AdMob payout."]);
    assert.deepEqual(teamText(s.store, "ops"), ["← CEO asked: Check the AdMob payout."]);
    const [job] = s.store.jobsWithStatus("queued");
    s.hub.start();
    await finished(s.hub, job.id);
    const [reply] = ["queued", "running", "done"]
      .flatMap((st) => s.store.jobsWithStatus(st))
      .filter((j) => j.kind === "reply");
    assert.equal(reply.agent, "ceo");
    assert.match(
      reply.prompt,
      /Ops finished the request you sent \(departments\/ops\/inbox\/2026-10-04-ceo-admob\.md\)/,
    );
    assert.match(teamText(s.store, "ceo")[1], /^← Ops replied: echo: /);
    assert.equal(teamText(s.store, "ops")[1], "→ Replied to CEO");
    await finished(s.hub, reply.id);
    assert.equal(s.store.queuedJobs().length, 0, "a reply doesn't start another reply");
  } finally {
    await s.close();
  }
});

test("a back-and-forth stops waking the asker after a few rounds an hour", async () => {
  const s = setup();
  try {
    s.hub.inboxTick();
    s.store.set("replies:ceo:ops", Array(6).fill(s.clock.now - 60_000));
    s.writeItem("ops", "2026-10-04-ceo-again.md", "ceo");
    s.hub.inboxTick();
    const [job] = s.store.jobsWithStatus("queued");
    s.hub.start();
    await finished(s.hub, job.id);
    assert.equal(queuedOf(s.store, "reply").length, 0, "held");
    assert.match(teamText(s.store, "ceo").at(-1), /^← Ops replied: /, "the line still shows");
    assert.ok(s.store.eventsSince(0).some((e) => e.type === "team.reply_held"));

    s.clock.now += 60 * 60_000; // an hour later the pair may talk again
    s.store.set("usage", { fiveHour: 0.1, sevenDay: 0.1, at: s.clock.now });
    s.writeItem("ops", "2026-10-04-ceo-later.md", "ceo");
    s.hub.inboxTick();
    const later = s.store.jobsWithStatus("queued").find((j) => j.kind === "inbox");
    await finished(s.hub, later.id);
    const replies = ["queued", "running", "done"]
      .flatMap((st) => s.store.jobsWithStatus(st))
      .filter((j) => j.kind === "reply");
    assert.equal(replies.length, 1);
  } finally {
    await s.close();
  }
});

test("an item from the user or the mailroom is no handoff: nobody gets a reply", async () => {
  const s = setup();
  try {
    s.hub.inboxTick();
    s.writeItem("ops", "2026-10-04-user-x.md", "user");
    s.hub.inboxTick();
    const [job] = s.store.jobsWithStatus("queued");
    s.hub.start();
    await finished(s.hub, job.id);
    assert.equal(queuedOf(s.store, "reply").length, 0);
    assert.deepEqual(teamText(s.store, "ops"), []);
  } finally {
    await s.close();
  }
});

function started(hub, jobId) {
  return new Promise((resolve) => {
    const check = () => {
      if (hub.job(jobId).status !== "queued") {
        hub.off("event", check);
        resolve(hub.job(jobId));
      }
    };
    hub.on("event", check);
    check();
  });
}

test("ask_teammate: the teammate answers at once and the asker hears it; no loops", async () => {
  const s = setup();
  try {
    s.hub.start();
    const asking = s.hub.enqueue({
      agent: "ceo",
      kind: "chat",
      priority: PRIORITY.user,
      prompt: "SLEEP",
    });
    await started(s.hub, asking.id);
    assert.throws(
      () => s.hub.ask({ jobId: 999, agent: "ops", question: "x" }),
      /only a run in progress/,
    );
    assert.throws(() => s.hub.ask({ jobId: asking.id, agent: "ceo", question: "x" }), /yourself/);
    assert.throws(() => s.hub.ask({ jobId: asking.id, agent: "ops", question: " " }), /say what/);

    const { job } = s.hub.ask({ jobId: asking.id, agent: "Ops", question: "What did AdMob pay?" });
    assert.equal(job.kind, "ask");
    assert.equal(job.agent, "ops");
    assert.match(job.prompt, /CEO is in the middle of a task/);
    assert.deepEqual(teamText(s.store, "ceo"), ["→ Asked Ops, waiting: What did AdMob pay?"]);
    const answered = await finished(s.hub, job.id);
    assert.equal(answered.status, "done");
    assert.match(answered.result, /^echo: /);
    assert.match(teamText(s.store, "ceo").at(-1), /^← Ops answered: echo: /);
    assert.equal(teamText(s.store, "ops").at(-1), "→ Answered CEO");
    assert.equal(s.hub.asks.size, 0);
    s.hub.cancel(asking.id);
  } finally {
    await s.close();
  }
});

test("ask_teammate: two agents can't wait on each other, and a finished asker drops its question", async () => {
  const s = setup();
  try {
    s.hub.start();
    const ceo = s.hub.enqueue({
      agent: "ceo",
      kind: "chat",
      priority: PRIORITY.user,
      prompt: "SLEEP",
    });
    const ops = s.hub.enqueue({
      agent: "ops",
      kind: "chat",
      priority: PRIORITY.user,
      prompt: "SLEEP",
    });
    await started(s.hub, ceo.id);
    await started(s.hub, ops.id);
    // Ops is busy, so the question waits in the queue.
    const { job } = s.hub.ask({ jobId: ceo.id, agent: "ops", question: "x" });
    assert.equal(s.hub.job(job.id).status, "queued");
    assert.throws(
      () => s.hub.ask({ jobId: ops.id, agent: "ceo", question: "y" }),
      /waiting on a teammate/,
    );
    s.hub.cancel(ceo.id);
    await finished(s.hub, ceo.id);
    assert.equal(s.hub.job(job.id).status, "cancelled", "nobody is waiting for it any more");
    assert.equal(s.hub.asks.size, 0);
    s.hub.cancel(ops.id);
  } finally {
    await s.close();
  }
});
