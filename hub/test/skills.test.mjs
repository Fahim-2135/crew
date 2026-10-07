// Skills agents write and improve themselves: the list in every run, and the review after
// real work.

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
  frontMatter,
  needsReview,
  savedNothing,
  reviewPrompt,
  skillEntry,
  skillsNote,
} from "../src/core/skills.mjs";
import { scorecard, scoreLine, trend, retroPrompt, DAY_MS } from "../src/core/scorecard.mjs";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

test("a SKILL.md's front matter becomes its entry; playbooks count as records", () => {
  assert.deepEqual(frontMatter("---\nname: demo-video\nversion: 3\n---\nbody"), {
    name: "demo-video",
    version: "3",
  });
  const skill = skillEntry({
    owner: "social",
    path: "B/departments/social/skills/demo-video/SKILL.md",
    text: "---\nname: demo-video\ndescription: Screen demo videos of Fahim's tools\nstage: skill\nversion: 3\n---\n# Demo video",
  });
  assert.equal(skill.stage, "skill");
  assert.equal(skill.version, 3);
  const record = skillEntry({
    owner: "social",
    path: "B/departments/social/skills/carousel/SKILL.md",
    text: "---\nname: carousel\nstage: record\n---\nSteps",
  });
  assert.equal(record.stage, "record");
  assert.equal(record.version, 0);
  const playbook = skillEntry({
    owner: "social",
    path: "B/departments/social/playbooks/linkedin-post-day-workflow.md",
    text: "# LinkedIn post day\n1. Draft",
    playbook: true,
  });
  assert.deepEqual(
    [playbook.name, playbook.stage, playbook.description],
    ["linkedin-post-day-workflow", "record", "LinkedIn post day"],
  );
});

test("the list shows an agent's own skills and records, and only teammates' finished skills", () => {
  const entries = [
    {
      owner: "social",
      path: "p1",
      name: "demo-video",
      description: "videos",
      stage: "skill",
      version: 2,
    },
    {
      owner: "social",
      path: "p2",
      name: "carousel",
      description: "carousels",
      stage: "record",
      version: 0,
    },
    {
      owner: "growth",
      path: "p3",
      name: "listing",
      description: "store listing",
      stage: "skill",
      version: 1,
    },
    {
      owner: "growth",
      path: "p4",
      name: "half-done",
      description: "x",
      stage: "record",
      version: 0,
    },
  ];
  const note = skillsNote({ agent: "social", brain: "C:\\brain", entries });
  assert.match(note, /demo-video \(skill v2\)/);
  assert.match(note, /carousel \(record\)/);
  assert.match(note, /listing \(skill v1, growth's\)/);
  assert.doesNotMatch(note, /half-done/);
  assert.match(note, /C:\/brain\/departments\/social\/skills/);
  assert.match(note, /Using skill: <name> \(v<version>\)/);
  assert.match(skillsNote({ agent: "ops", brain: "B", entries: [] }), /Yours: none yet/);
});

test("only real work is reviewed, and the review says how to save or improve the skill", () => {
  assert.equal(needsReview({ kind: "chat" }, 5), true);
  assert.equal(needsReview({ kind: "chat" }, 4), false);
  assert.equal(needsReview({ kind: "review" }, 20), false);
  assert.equal(needsReview({ kind: "learn" }, 20), false);
  assert.equal(needsReview({ kind: "inbox" }, 9), true);
  const prompt = reviewPrompt({
    agent: "social",
    brain: "C:/brain",
    request: "make the tweak demo video",
    today: "2026-10-07",
    owner: "Fahim",
  });
  assert.match(prompt, /make the tweak demo video/);
  assert.match(prompt, /history\/v<old version>\.md/);
  assert.match(prompt, /CHANGELOG\.md/);
  assert.match(prompt, /stage: record/);
  assert.match(prompt, /nothing to save/);
});

/** A hub over a temp brain, running the fake Claude as a real process. */
function setup(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "crew-skills-"));
  const brain = join(root, "brain");
  const agentsDir = join(root, "agents");
  const runs = join(root, "runs");
  for (const dir of [brain, agentsDir, runs]) mkdirSync(dir, { recursive: true });
  for (const a of ["ceo", "social", "engineering"]) {
    writeFileSync(
      join(agentsDir, `${a}.md`),
      `---\nname: ${a}\ndescription: ${a}\nmodel: sonnet\n---\n\nYou are ${a}.\n`,
    );
  }
  const store = new Store(":memory:");
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain, agentsDir, runs, crewGuard: "guard.mjs", gateHook: "gate-hook.mjs" },
    bin: FAKE,
    runTurn,
    sessions: () => [],
    killTree,
    afterWrite: () => {},
    ...extra,
  });
  return { root, brain, store, hub };
}

/** Resolve once nothing has been queued or running for a moment. */
async function settled(hub) {
  const busy = () =>
    hub.store.jobsWithStatus("queued").length + hub.store.jobsWithStatus("running").length;
  let quiet = 0;
  while (quiet < 3) {
    await new Promise((r) => setTimeout(r, 60));
    quiet = busy() ? 0 : quiet + 1;
  }
}

test("after real work the agent gets a review turn; a quick answer gets none", async () => {
  const { root, brain, store, hub } = setup();
  try {
    hub.start();
    hub.send("social", "TOOLS5 make the tweak demo video");
    await settled(hub);
    let jobs = store.jobsWithStatus("done");
    assert.deepEqual(
      jobs.map((j) => j.kind),
      ["chat", "review"],
      "the review follows the task",
    );
    const review = jobs.find((j) => j.kind === "review");
    assert.match(review.prompt, /make the tweak demo video/);
    // The review shows as a small note in the chat.
    const last = hub.messages("social").pop();
    assert.equal(last.role, "note");
    assert.match(last.text, /^Skills: /);

    hub.send("social", "what time is it?");
    await settled(hub);
    jobs = store.jobsWithStatus("done");
    assert.equal(jobs.filter((j) => j.kind === "review").length, 1, "no review for a quick answer");

    // Skills on disk show up in the next run's instructions, teammates' too.
    const dir = join(brain, "departments", "social", "skills", "demo-video");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: demo-video\ndescription: Screen demo videos\nstage: skill\nversion: 2\n---\n# Steps",
    );
    hub.send("engineering", "hello");
    await settled(hub);
    const appended = hub.lastRun.args[hub.lastRun.args.indexOf("--append-system-prompt") + 1];
    assert.match(appended, /# Your skills/);
    assert.match(appended, /demo-video \(skill v2, social's\)/);
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a review that saved nothing leaves the chat alone", () => {
  assert.equal(savedNothing("Nothing to save."), true);
  assert.equal(savedNothing("  nothing to save  "), true);
  assert.equal(savedNothing('Saved demo-video v4 (was: "nothing to save" before)'), false);
  assert.equal(savedNothing("Nothing to save: it was a one-off test."), true);
});

test("the score compares this week with the week before", () => {
  const now = 100 * DAY_MS;
  const day = (n) => now - n * DAY_MS;
  const job = (kind, at, extra = {}) => ({ kind, createdAt: at, status: "done", ...extra });
  const card = scorecard({
    now,
    jobs: [
      // this week: 2 real tasks, one done with a skill, one failed run
      job("chat", day(1), { result: "Using skill: demo-video (v3)\nDone." }),
      job("review", day(1)),
      job("chat", day(2), { result: "Done." }),
      job("review", day(2)),
      job("chat", day(3), { status: "failed" }),
      // the week before: 1 real task, 2 thumbs down
      job("chat", day(9), { result: "Done." }),
      job("review", day(9)),
    ],
    feedback: [
      { rating: "down", at: day(8) },
      { rating: "down", at: day(10) },
      { rating: "up", at: day(1) },
    ],
    approvals: [
      { status: "denied", createdAt: day(2) },
      { status: "approved", createdAt: day(2) },
    ],
    skills: [
      { stage: "skill", version: 3 },
      { stage: "skill", version: 1 },
      { stage: "record", version: 0 },
    ],
  });
  assert.equal(card.week.realTasks, 2);
  assert.equal(card.week.withSkill, 1);
  assert.equal(card.week.skillShare, 0.5);
  assert.equal(card.week.corrections, 2, "one said no, one failed");
  assert.equal(card.before.corrections, 2, "two thumbs down");
  assert.equal(card.week.correctionsPerTask, 1);
  assert.equal(card.before.correctionsPerTask, 2);
  assert.equal(trend(card), "better");
  assert.deepEqual(card.skills, { skills: 2, records: 1, improvements: 2 });
  assert.match(scoreLine(card), /2 real tasks in 7 days; 50% done with a skill/);
  const prompt = retroPrompt({
    agent: "social",
    brain: "C:\\brain",
    today: "2026-10-11",
    owner: "Fahim",
    card,
    corrections: ["Said no to: Post the draft (too long)"],
  });
  assert.match(prompt, /Said no to: Post the draft \(too long\)/);
  assert.match(prompt, /C:\/brain\/departments\/social\/skills/);
  assert.match(prompt, /agent\.update/);
});

test("on the look-back day each agent that did real work gets one look-back, once", () => {
  // Sunday 2026-10-11, 10:30 in UTC+6.
  const now = Date.UTC(2026, 9, 11, 4, 30);
  const { root, brain, store, hub } = setup({ now: () => now, utcOffsetMinutes: () => 360 });
  try {
    for (const kind of ["chat", "review"]) {
      const j = store.addJob({
        agent: "social",
        kind,
        priority: 0,
        prompt: "video",
        createdAt: now - DAY_MS,
      });
      store.updateJob(j.id, { status: "done", endedAt: now - DAY_MS });
    }
    const dir = join(brain, "departments", "social", "skills", "demo-video");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: demo-video\nstage: skill\nversion: 2\n---\n");
    writeFileSync(join(dir, "CHANGELOG.md"), "2026-10-07 v1: first\n2026-10-08 v2: zoom timing\n");

    hub.retroTick();
    hub.retroTick();
    const retros = store.queuedJobs().filter((j) => j.kind === "retro");
    assert.deepEqual(
      retros.map((j) => j.agent),
      ["social"],
      "only the agent that worked, once",
    );
    assert.match(retros[0].prompt, /1 real task in 7 days/);

    const skills = hub.skillsOf("social");
    assert.equal(skills[0].name, "demo-video");
    assert.deepEqual(skills[0].changes, ["2026-10-08 v2: zoom timing", "2026-10-07 v1: first"]);
    assert.equal(hub.score("social").skills.improvements, 1);
  } finally {
    hub.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("not on other days or before the hour", () => {
  const monday = Date.UTC(2026, 9, 12, 4, 30);
  const early = Date.UTC(2026, 9, 11, 2, 0); // Sunday 08:00 local
  for (const now of [monday, early]) {
    const { root, store, hub } = setup({ now: () => now, utcOffsetMinutes: () => 360 });
    try {
      const j = store.addJob({
        agent: "social",
        kind: "review",
        priority: 0,
        prompt: "x",
        createdAt: now - 1000,
      });
      store.updateJob(j.id, { status: "done" });
      hub.retroTick();
      assert.equal(store.queuedJobs().filter((q) => q.kind === "retro").length, 0);
    } finally {
      hub.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
