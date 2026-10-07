import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  validateRequest,
  approvalCode,
  decide,
  expired,
  needReminder,
  outcomeMessage,
  REMIND_AFTER_MS,
} from "../src/core/approvals.mjs";
import { capturePreconditions, execute } from "../src/io/executors.mjs";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { createApi } from "../src/io/http.mjs";
import { PRIORITY } from "../src/core/budget.mjs";
import { testConfig } from "./team-config.mjs";

const MCP = fileURLToPath(new URL("../src/io/mcp-crew.mjs", import.meta.url));
const BRAIN = "C:/Users/me/brain";

// --- pure rules

test("requests are validated into exactly the fields each action needs", () => {
  const ok = validateRequest(
    {
      type: "git.push",
      summary: " Push the fix ",
      payload: { repo: "C:/r", remote: "origin", branch: "crew/a-2345", extra: "x" },
    },
    { brainDir: BRAIN },
  );
  assert.deepEqual(ok, {
    type: "git.push",
    summary: "Push the fix",
    why: "",
    payload: { repo: "C:/r", remote: "origin", branch: "crew/a-2345" },
  });
  const bad = (request, pattern) =>
    assert.throws(() => validateRequest(request, { brainDir: BRAIN }), pattern);
  bad({ type: "deploy", summary: "s", payload: {} }, /unknown action type/);
  bad({ type: "post", summary: "", payload: { platform: "x", text: "y" } }, /summary is required/);
  bad({ type: "post", summary: "s", payload: { platform: "x" } }, /missing text/);
  bad(
    { type: "command", summary: "s", payload: { command: "ls", cwd: "relative" } },
    /cwd must be an absolute/,
  );
  bad(
    { type: "command", summary: "s", payload: { command: "ls\nrm x", cwd: "C:/r" } },
    /single line/,
  );
  bad(
    {
      type: "git.push",
      summary: "s",
      payload: { repo: "C:/r", remote: "origin", branch: "--force" },
    },
    /branch/,
  );
  bad(
    { type: "git.push", summary: "s", payload: { repo: "C:/r", remote: "a b", branch: "main" } },
    /remote/,
  );
  bad(
    { type: "patch.apply", summary: "s", payload: { repo: "C:/r", patch: "E:/elsewhere/x.patch" } },
    /inside the brain/,
  );
  assert.equal(
    validateRequest(
      {
        type: "patch.apply",
        summary: "s",
        payload: { repo: "C:/r", patch: `${BRAIN}/departments/engineering/outputs/x.patch` },
      },
      { brainDir: BRAIN },
    ).type,
    "patch.apply",
  );
});

test("codes are short, readable, and unique among pending requests", () => {
  const values = [0, 0, 0, 0, 0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99];
  const random = () => values.shift();
  const first = approvalCode(random, new Set());
  assert.equal(first, "A-2222");
  assert.equal(approvalCode(random, new Set(["A-2222"])), "A-ZZZZ", "a taken code is drawn again");
});

test("the first decision wins; duplicates are harmless; a different late answer is refused", () => {
  const pending = { status: "pending", decision: null, nonce: null, expiresAt: 100 };
  assert.deepEqual(decide(pending, { decision: "approve", nonce: "n1", now: 1 }), {
    changed: true,
    status: "approved",
  });
  assert.deepEqual(decide(pending, { decision: "deny", nonce: "n1", now: 1 }), {
    changed: true,
    status: "denied",
  });
  assert.equal(
    decide(pending, { decision: "maybe", nonce: "n", now: 1 }).error,
    "decision must be approve or deny",
  );
  assert.equal(decide(pending, { decision: "approve", nonce: "n", now: 100 }).status, "expired");

  const done = { status: "executed", decision: "approve", nonce: "n1", expiresAt: 100 };
  assert.deepEqual(decide(done, { decision: "approve", nonce: "n1", now: 5 }), {
    changed: false,
    status: "executed",
  });
  assert.deepEqual(decide(done, { decision: "approve", nonce: "other-device", now: 5 }), {
    changed: false,
    status: "executed",
  });
  assert.match(decide(done, { decision: "deny", nonce: "n2", now: 5 }).error, /already executed/);
});

test("expiry and reminders", () => {
  const list = [
    { id: 1, status: "pending", createdAt: 0, expiresAt: 50 },
    { id: 2, status: "pending", createdAt: 0, expiresAt: 10 * REMIND_AFTER_MS },
    { id: 3, status: "pending", createdAt: 0, expiresAt: 10 * REMIND_AFTER_MS, remindedAt: 5 },
    { id: 4, status: "denied", createdAt: 0, expiresAt: 1 },
  ];
  assert.deepEqual(
    expired(list, 60).map((a) => a.id),
    [1],
  );
  assert.deepEqual(
    needReminder(list, REMIND_AFTER_MS).map((a) => a.id),
    [1, 2],
  );
});

test("the agent hears plainly what happened", () => {
  const base = { code: "A-7F3K", summary: "Apply the crash fix" };
  assert.match(
    outcomeMessage({ ...base, status: "executed", result: "Committed abc" }),
    /approved, and it is done[\s\S]*Committed abc/,
  );
  assert.match(
    outcomeMessage({ ...base, status: "denied", note: "not now" }),
    /no\. Their note: not now/,
  );
  assert.match(outcomeMessage({ ...base, status: "expired" }), /expired and was not done/);
  assert.match(
    outcomeMessage({ ...base, status: "handed-over" }),
    /They will do this one themselves/,
  );
  assert.match(
    outcomeMessage({ ...base, status: "stale", result: "HEAD moved" }),
    /repository changed/,
  );
});

// --- carrying it out, on a real scratch repository

function git(cwd, ...args) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "crew-exec-"));
  const repo = join(root, "repo");
  const brain = join(root, "brain");
  mkdirSync(repo);
  mkdirSync(join(brain, "departments", "engineering", "outputs"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "app.txt"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const patch = join(brain, "departments", "engineering", "outputs", "fix.patch");
  writeFileSync(
    patch,
    "diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-hello\n+hello, fixed\n",
  );
  return { root, repo, brain, patch };
}

test("patch.apply commits on its own branch and leaves the user's branch untouched", async () => {
  const { root, repo, patch } = scratchRepo();
  try {
    const request = { type: "patch.apply", summary: "Fix the greeting", payload: { repo, patch } };
    const preconditions = capturePreconditions(request);
    assert.match(preconditions.head, /^[0-9a-f]{40}$/);
    const result = await execute({ ...request, code: "A-7F3K", preconditions });
    assert.equal(result.status, "executed", result.result);
    assert.match(result.result, /branch crew\/a-7f3k/);
    assert.equal(git(repo, "show", "crew/a-7f3k:app.txt"), "hello, fixed");
    assert.equal(readFileSync(join(repo, "app.txt"), "utf8"), "hello\n", "working copy unchanged");
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "temporary worktree removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a moved HEAD or an edited patch makes the approval stale; a bad patch is refused early", async () => {
  const { root, repo, patch } = scratchRepo();
  try {
    const request = { type: "patch.apply", summary: "Fix", payload: { repo, patch } };
    const preconditions = capturePreconditions(request);
    writeFileSync(join(repo, "other.txt"), "x");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "moved");
    assert.equal((await execute({ ...request, code: "A-2345", preconditions })).status, "stale");

    const fresh = capturePreconditions(request);
    writeFileSync(patch, readFileSync(patch, "utf8") + "\n");
    assert.equal(
      (await execute({ ...request, code: "A-2346", preconditions: fresh })).status,
      "stale",
    );

    writeFileSync(patch, "not a diff");
    assert.throws(() => capturePreconditions(request), /does not apply cleanly|No valid patches/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git.push pushes exactly the approved branch, unless it moved", async () => {
  const { root, repo } = scratchRepo();
  try {
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    const request = {
      type: "git.push",
      summary: "Push main",
      payload: { repo, remote: "origin", branch: "main" },
    };
    const result = await execute({
      ...request,
      code: "A-3456",
      preconditions: capturePreconditions(request),
    });
    assert.equal(result.status, "executed", result.result);
    assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "main"));

    const pre = capturePreconditions(request);
    writeFileSync(join(repo, "more.txt"), "x");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more");
    assert.equal(
      (await execute({ ...request, code: "A-3457", preconditions: pre })).status,
      "stale",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command runs the exact line; posts and mail are handed to the user", async () => {
  const { root, repo } = scratchRepo();
  try {
    const ok = await execute({
      type: "command",
      payload: { command: "echo crew-ran && cat app.txt", cwd: repo },
      preconditions: {},
    });
    assert.equal(ok.status, "executed");
    assert.match(ok.result, /crew-ran[\s\S]*hello/);
    const bad = await execute({
      type: "command",
      payload: { command: "exit 3", cwd: repo },
      preconditions: {},
    });
    assert.equal(bad.status, "failed");
    assert.match(bad.result, /exit 3/);
    assert.equal(
      (await execute({ type: "post", payload: {}, preconditions: {} })).status,
      "handed-over",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the hub flow

function hubSetup(options = {}) {
  const store = new Store(":memory:");
  const clock = { now: 1_000_000 };
  const executed = [];
  const prompts = [];
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain: BRAIN, agentsDir: "unused", runs: "unused", crewGuard: "g" },
    bin: "unused",
    runTurn: (run) => {
      prompts.push(run.prompt);
      return { pid: 1, kill() {}, done: new Promise(() => {}) };
    },
    sessions: () => [],
    execute: async (a) => {
      executed.push(a.code);
      return { status: "executed", result: "did it" };
    },
    capturePreconditions: () => ({ head: "abc" }),
    random: options.random,
    now: () => clock.now,
  });
  // Pretend a run of `social` is in progress: only a running job may ask.
  const job = store.addJob({
    agent: "social",
    kind: "chat",
    priority: 0,
    prompt: "p",
    createdAt: 1,
  });
  store.updateJob(job.id, { status: "running" });
  const ask = (overrides = {}) =>
    hub.requestApproval({
      jobId: job.id,
      agent: "social",
      type: "post",
      summary: "Post the launch line",
      payload: { platform: "LinkedIn", text: "The app is live" },
      ...overrides,
    });
  return { store, hub, clock, job, executed, prompts, ask };
}

test("only the run in progress may ask, and only as itself", () => {
  const { hub, job, ask } = hubSetup();
  assert.throws(() => ask({ agent: "ops" }), /only the run in progress/);
  assert.throws(() => ask({ jobId: job.id + 99 }), /only the run in progress/);
  assert.throws(() => ask({ type: "deploy" }), /unknown action type/);
  const a = ask();
  assert.match(a.code, /^A-[2-9A-Z]{4}$/);
  assert.equal(hub.agents().find((x) => x.id === "social").state, "working", "still running");
});

test("approving runs the action, then the agent gets a turn to hear the result", async () => {
  const { store, hub, ask, executed } = hubSetup();
  const a = ask({
    type: "command",
    summary: "Run the tests",
    payload: { command: "rm -rf build", cwd: "C:/r" },
  });
  assert.match(a.risk, /deletes files/, "risky commands are flagged before Maya decides");
  store.updateJob(a.jobId, { status: "done", endedAt: 1 });
  assert.equal(hub.agents().find((x) => x.id === "social").state, "asking");

  const decided = await hub.decideApproval(a.code, { decision: "approve", nonce: "n1" });
  assert.equal(decided.status, "executed");
  assert.equal(decided.result, "did it");
  assert.equal(decided.nonce, undefined, "the nonce never leaves the hub");
  assert.deepEqual(executed, [a.code]);
  const followUp = store.queuedJobs().find((j) => j.kind === "approval");
  assert.equal(followUp.priority, PRIORITY.approved);
  assert.match(followUp.prompt, /approved, and it is done/);

  const again = await hub.decideApproval(a.code, { decision: "approve", nonce: "n1" });
  assert.equal(again.status, "executed");
  assert.equal(executed.length, 1, "a replayed decision never runs the action twice");
  await assert.rejects(
    hub.decideApproval(a.code, { decision: "deny", nonce: "n2" }),
    /already executed/,
  );
});

test("a no becomes a notice the agent reads at the start of its next turn", async () => {
  const { store, hub, ask, prompts } = hubSetup();
  const a = ask();
  await hub.decideApproval(a.id, { decision: "deny", nonce: "n", note: "wait until Monday" });
  assert.equal(store.queuedJobs().length, 0, "a no does not start a run");
  assert.match(hub.takeNotices("social")[0], /Their note: wait until Monday/);
  hub.notify("social", "Crew: a notice");
  store.updateJob(a.jobId, { status: "done" });
  // runJob needs the agent definition file; check the notices are consumed by takeNotices instead.
  assert.deepEqual(hub.takeNotices("social"), ["Crew: a notice"]);
  assert.deepEqual(hub.takeNotices("social"), []);
  assert.equal(prompts.length, 0);
});

test("unanswered requests get one reminder, then expire with a notice", () => {
  const { hub, clock, ask, store } = hubSetup();
  const a = ask();
  clock.now += REMIND_AFTER_MS;
  hub.approvalsTick();
  hub.approvalsTick();
  assert.equal(store.eventsSince(0).filter((e) => e.type === "approval.reminder").length, 1);
  clock.now += 8 * 24 * 3600_000;
  hub.approvalsTick();
  assert.equal(hub.approval(a.code).status, "expired");
  assert.match(hub.takeNotices("social")[0], /expired and was not done/);
});

// --- the crew MCP server, end to end through the API

test("the crew tool server turns an agent's tool call into a pending approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "crew-mcp-"));
  const { store, hub, job } = hubSetup();
  const token = "k".repeat(64);
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, token);
  const probe = createApi(hub, { port: 0, token });
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  probe.close();
  const api = createApi(hub, { port, token });
  await new Promise((r) => api.listen(port, "127.0.0.1", r));

  const server = spawn(process.execPath, [MCP], {
    env: {
      ...process.env,
      CREW_JOB: String(job.id),
      CREW_AGENT: "social",
      CREW_PORT: String(port),
      CREW_TOKEN_FILE: tokenFile,
    },
  });
  const replies = [];
  const waiters = [];
  createInterface({ input: server.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    const i = waiters.findIndex((w) => w.id === msg.id);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else replies.push(msg);
  });
  const call = (id, method, params) =>
    new Promise((resolve) => {
      waiters.push({ id, resolve });
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    assert.equal(
      (await call(1, "initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name,
      "crew",
    );
    const { tools } = (await call(2, "tools/list", {})).result;
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        "request_approval",
        "ask_teammate",
        "schedule_check",
        "list_checks",
        "cancel_check",
        "set_progress",
      ],
    );
    const ask = tools[1].description;
    assert.match(ask, /ceo \(CEO\)/, "names the teammates");
    assert.doesNotMatch(ask, /social \(/, "but not the agent itself");
    const self = await call(5, "tools/call", {
      name: "ask_teammate",
      arguments: { agent: "social", question: "x" },
    });
    assert.equal(self.result.isError, true);
    assert.match(self.result.content[0].text, /^Not asked: /);

    const ok = await call(3, "tools/call", {
      name: "request_approval",
      arguments: {
        type: "post",
        summary: "Post it",
        payload: { platform: "LinkedIn", text: "Hi" },
      },
    });
    assert.match(ok.result.content[0].text, /^Queued as A-/);
    assert.equal(store.approvals("pending").length, 1);

    const bad = await call(4, "tools/call", {
      name: "request_approval",
      arguments: { type: "post", summary: "x", payload: {} },
    });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /Not queued: payload is missing/);
  } finally {
    server.kill();
    api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
