// Creating agents: the agent.create request, the files Crew lays down once the user approves,
// and the team list everywhere growing to include the new one.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRequest } from "../src/core/approvals.mjs";
import { parseAgentFile } from "../src/core/agents.mjs";
import { createAgent } from "../src/io/team.mjs";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { pushFor } from "../src/core/push.mjs";
import { testConfig } from "./team-config.mjs";

const REQUEST = {
  type: "agent.create",
  summary: "A Reviews agent that watches Play Store reviews",
  why: "Maya asked for one",
  payload: {
    id: "Reviews",
    title: "Reviews",
    description: "Reads the app's Play Store reviews and flags patterns.",
    instructions:
      "You read new Play Store reviews, group them by theme, and tell Maya what to fix.",
    web: "YES",
    icon: "Glasses",
  },
};

/** A temp brain laid out like the real one, and a temp ~/.claude. */
function fakeBrain() {
  const root = mkdtempSync(join(tmpdir(), "crew-team-"));
  const brainDir = join(root, "brain");
  const agentsDir = join(root, "claude", "agents", "brain");
  mkdirSync(join(brainDir, "config"), { recursive: true });
  mkdirSync(join(brainDir, "departments", "ops"), { recursive: true });
  writeFileSync(
    join(brainDir, "config", "agents.json"),
    [
      "{",
      '  "_comment": "Write scopes per agent.",',
      '  "agents": {',
      '    "ceo":         { "write": ["**"], "outside": "write" },',
      '    "ops":         { "write": ["departments/ops/**"], "outside": "read" }',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  return { root, brainDir, agentsDir };
}

test("agent.create requests are checked before the user sees them", () => {
  const clean = validateRequest(REQUEST, { brainDir: "C:/brain" });
  assert.equal(clean.payload.id, "reviews");
  assert.equal(clean.payload.web, "yes");
  const bad = (payload, pattern) =>
    assert.throws(
      () => validateRequest({ ...REQUEST, payload: { ...REQUEST.payload, ...payload } }, {}),
      pattern,
    );
  bad({ id: "re" }, /3-20 lowercase/);
  bad({ id: "my-agent" }, /3-20 lowercase/);
  bad({ id: "ceo" }, /already taken/);
  bad({ id: "mailroom" }, /already taken/);
  bad({ title: "x".repeat(25) }, /title is too long/);
  bad({ web: "maybe" }, /yes or no/);
  bad({ icon: "dragon" }, /icon must be auto/);
  bad({ instructions: "" }, /missing instructions/);
});

test("an approved agent gets a definition, a department, a write scope and a memory link", () => {
  const { root, brainDir, agentsDir } = fakeBrain();
  try {
    const payload = validateRequest(REQUEST, { brainDir }).payload;
    const out = createAgent(payload, { brainDir, agentsDir, today: "2026-10-05" });
    assert.equal(out.status, "executed", out.result);

    const def = parseAgentFile(readFileSync(join(agentsDir, "reviews.md"), "utf8"));
    assert.equal(def.name, "reviews");
    assert.deepEqual(def.tools, [], "no tools line: the full toolset, as for the rest of the team");
    assert.match(def.body, /You are \*\*Reviews\*\*/);
    assert.match(def.body, /group them by theme/);
    assert.equal(
      readFileSync(join(brainDir, "system", "agents", "reviews.md"), "utf8"),
      readFileSync(join(agentsDir, "reviews.md"), "utf8"),
    );
    for (const p of ["README.md", "memory/MEMORY.md", "inbox", "outputs"]) {
      assert.ok(existsSync(join(brainDir, "departments", "reviews", p)), p);
    }

    // The guard config keeps its layout and gains one line.
    const config = readFileSync(join(brainDir, "config", "agents.json"), "utf8");
    assert.match(config, /"ops": {9}\{/);
    assert.deepEqual(JSON.parse(config).agents.reviews.write[0], "departments/reviews/**");
    assert.equal(JSON.parse(config).agents.reviews.outside, "write");

    const link = join(root, "claude", "agent-memory", "reviews");
    assert.ok(lstatSync(link).isSymbolicLink());

    // A second request for the same name changes nothing.
    assert.equal(
      createAgent(payload, { brainDir, agentsDir, today: "2026-10-05" }).status,
      "stale",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("once approved, the new agent is on the team: listed, titled, messageable, in pushes", async () => {
  const { root, brainDir, agentsDir } = fakeBrain();
  const store = new Store(":memory:");
  const written = [];
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain: brainDir, agentsDir, runs: root, crewGuard: "guard.mjs" },
    bin: "none",
    runTurn: () => {
      throw new Error("no runs here");
    },
    sessions: () => [],
    createAgent,
    afterWrite: () => written.push(true),
  });
  hub.stop();
  try {
    const before = hub.agents().length;
    // What the CEO's request_approval call would have stored.
    const payload = validateRequest(REQUEST, { brainDir }).payload;
    store.addApproval({
      id: "a1",
      code: "A-NEW1",
      agent: "ceo",
      type: "agent.create",
      summary: REQUEST.summary,
      payload,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    });
    const decided = await hub.decideApproval("A-NEW1", { decision: "approve", nonce: "n1" });
    assert.equal(decided.status, "executed", decided.result);

    const team = hub.agents();
    assert.equal(team.length, before + 1);
    assert.deepEqual(team.map((a) => [a.id, a.title]).at(-1), ["reviews", "Reviews"]);
    assert.equal(team[0].title, "CEO");
    const job = hub.send("reviews", "What did people say this week?");
    assert.equal(job.agent, "reviews");
    assert.equal(written.length, 1, "the brain index is rebuilt");
    assert.equal(
      pushFor(
        { type: "approval.requested", data: { agent: "reviews", code: "A-2" } },
        { titles: { reviews: "Reviews" } },
      ).title,
      "Reviews needs you",
    );

    // A new agent starts without memory; "Sync memory" has the CEO fill it in once.
    const fresh = () => hub.agents().find((x) => x.id === "reviews");
    assert.equal(fresh().memory, "unsynced");
    assert.equal(hub.agents()[0].created, undefined, "the first eight need no sync");
    const { job: sync } = hub.syncMemory("reviews");
    assert.equal(sync.agent, "ceo");
    assert.ok(store.job(sync.id).prompt.includes("departments/reviews/memory"));
    assert.match(store.job(sync.id).prompt, /Where to look/);
    assert.equal(store.messages("ceo").at(-1).text, "Sync memory for Reviews");
    assert.equal(fresh().memory, "syncing");
    assert.equal(hub.syncMemory("reviews").job.id, sync.id, "one sync at a time");
    hub.finish(store.job(sync.id), "done", { result: "Gave it 4 notes." });
    assert.equal(fresh().memory, "synced");
    assert.throws(() => hub.syncMemory("ops"), /only agents created/);

    // The icon picked at creation is the one it wears.
    assert.equal(hub.agents().find((x) => x.id === "reviews").icon, "glasses");

    // Rename and re-icon any agent: only the name on screen changes, and the agent is told.
    assert.deepEqual(hub.setProfile("ops", { title: "  Sheriff  ", icon: "cowboy" }), {
      title: "Sheriff",
      icon: "cowboy",
    });
    const ops = hub.agents().find((x) => x.id === "ops");
    assert.deepEqual([ops.title, ops.icon], ["Sheriff", "cowboy"]);
    assert.ok(
      store.get("notices", {}).ops.at(-1).includes('You are now "Sheriff" (you were "Ops")'),
    );
    assert.throws(() => hub.setProfile("ops", { icon: "dragon" }), /25 icons/);
    assert.throws(() => hub.setProfile("ops", { title: "" }), /1-24/);
    assert.throws(() => hub.setProfile("nobody", { title: "x" }), /no agent/);

    // A name and icon chosen with the brief go to the CEO's draft.
    const named = hub.draftAgent("reads my calendar", "pc", { title: "Planner", icon: "star" });
    assert.match(store.job(named.id).prompt, /They named it "Planner"/);
    assert.match(store.job(named.id).prompt, /icon star/);
    assert.equal(store.messages("ceo").at(-1).text, 'New agent "Planner": reads my calendar');

    // Drafting goes to the CEO, and the chat shows only the user's words.
    const draft = hub.draftAgent("an agent for my study plan");
    assert.equal(draft.agent, "ceo");
    assert.match(store.job(draft.id).prompt, /agent\.create/);
    assert.equal(store.messages("ceo").at(-1).text, "New agent: an agent for my study plan");
    assert.throws(() => hub.draftAgent("  "), /say what/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Open in terminal continues the agent's own session, and only once it has one", () => {
  const store = new Store(":memory:");
  const opened = [];
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain: "C:/brain", agentsDir: "C:/agents", runs: tmpdir(), crewGuard: "guard.mjs" },
    bin: "none",
    runTurn: () => {
      throw new Error("no runs here");
    },
    sessions: () => [],
    openTerminal: (o) => opened.push(o),
  });
  hub.stop();
  try {
    assert.throws(() => hub.openInTerminal("ops"), /no conversation yet/);
    const thread = store.createThread({
      agent: "ops",
      sessionId: "sid-1",
      createdAt: 1,
      agentHash: "h",
    });
    store.markThreadStarted(thread.id);
    assert.deepEqual(hub.openInTerminal("ops"), { ok: true });
    assert.deepEqual(opened, [
      { agent: "ops", title: "Crew - Ops", sessionId: "sid-1", cwd: "C:/brain" },
    ]);
    assert.throws(() => hub.openInTerminal("nobody"), /no agent/);
  } finally {
    store.close();
  }
});
