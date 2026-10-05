import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { runTurn, killTree } from "../src/io/claude.mjs";
import { createApi } from "../src/io/http.mjs";
import { testConfig } from "./team-config.mjs";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

const AGENT_MD = (name) => `---
name: ${name}
description: ${name} department
tools: Read, Write, Edit, Glob, Grep, Bash
model: sonnet
memory: user
---

You are ${name}.
`;

/** A hub over a temp brain and agents folder, running the fake Claude as a real process. */
function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "crew-hub-"));
  const brain = join(root, "brain");
  const agentsDir = join(root, "agents");
  const runs = join(root, "runs");
  for (const dir of [brain, agentsDir, runs]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(brain, "BRIEF.md"), "# Brief\nPayments first.");
  for (const a of ["ceo", "social", "engineering"])
    writeFileSync(join(agentsDir, `${a}.md`), AGENT_MD(a));

  const store = new Store(":memory:");
  const written = [];
  const open = options.openSessions ?? new Set();
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: {
      brain,
      agentsDir,
      runs,
      crewGuard: "guard.mjs",
      gateHook: "E:/crew/hub/src/io/gate-hook.mjs",
    },
    bin: FAKE,
    runTurn,
    sessions: () =>
      [...open].map((sessionId) => ({ sessionId, kind: "interactive", status: "idle" })),
    killTree,
    afterWrite: () => written.push(true),
  });
  return { root, store, hub, written, open, agentsDir };
}

/** Resolve when a job reaches a final status. */
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

test("a message runs as a turn in the agent's thread, and the next one resumes it", async () => {
  const { root, store, hub } = setup();
  try {
    hub.start();
    const first = await finished(hub, hub.send("social", "hello").id);
    assert.equal(first.status, "done");
    assert.equal(first.result, "echo: hello");

    const thread = store.activeThread("social");
    assert.equal(thread.turns, 1);
    assert.equal(thread.lastContextTokens, 1210);

    const second = await finished(hub, hub.send("social", "again").id);
    assert.equal(second.threadId, thread.id, "same thread");
    assert.deepEqual(
      hub.messages("social").map((m) => [m.role, m.text]),
      [
        ["you", "hello"],
        ["agent", "echo: hello"],
        ["you", "again"],
        ["agent", "echo: again"],
      ],
    );
    assert.equal(hub.budget().usage.fiveHour, 0.25, "usage comes from the stream");
    assert.equal(hub.agents().find((a) => a.id === "social").state, "done");
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run starts like the terminal: the agent itself, the user's settings, and Crew's gate", async () => {
  const { root, store, hub } = setup();
  hub.workDirs = ["C:/", "E:/"];
  try {
    hub.start();
    await finished(hub, hub.send("engineering", "hi").id);
    const { args, env, settingsPath } = hub.lastRun;
    const flag = (name) => args[args.indexOf(name) + 1];
    assert.equal(flag("--agent"), "engineering");
    assert.equal(flag("--permission-mode"), "bypassPermissions");
    assert.ok(
      !args.includes("--tools") &&
        !args.includes("--setting-sources") &&
        !args.includes("--agents"),
    );
    assert.deepEqual(
      args.flatMap((x, i) => (x === "--add-dir" ? [args[i + 1]] : [])),
      ["C:/", "E:/"],
    );
    const settings = JSON.parse((await import("node:fs")).readFileSync(settingsPath, "utf8"));
    const gate = settings.hooks.PreToolUse[0];
    assert.equal(gate.matcher, "*");
    assert.match(gate.hooks[0].command, /gate-hook.mjs"$/);
    assert.equal(env.CREW_JOB, String(store.latestJob("engineering").id));
    assert.equal(env.CREW_WORKER, "1");
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop-all kills every running turn within 5 seconds and holds the queue", async () => {
  const { root, store, hub } = setup();
  try {
    hub.start();
    const sleeping = [hub.send("social", "SLEEP"), hub.send("ceo", "SLEEP")];
    const waiting = hub.send("social", "after");
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(hub.budget().running.length, 2);
    const t0 = Date.now();
    hub.stopAll();
    for (const job of sleeping) assert.equal((await finished(hub, job.id)).status, "cancelled");
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(hub.job(waiting.id).status, "queued", "held while paused");

    hub.resumeAll();
    assert.equal((await finished(hub, waiting.id)).status, "done");
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents work side by side, each one run at a time, and a call gets a slot past the limit", async () => {
  const { root, store, hub } = setup();
  hub.config = { ...hub.config, maxRuns: 2 };
  try {
    hub.start();
    const social = hub.send("social", "SLEEP");
    const ceo = hub.send("ceo", "SLEEP");
    const socialAgain = hub.send("social", "two");
    const engineering = hub.send("engineering", "hi");
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(hub.budget().running.sort(), [social.id, ceo.id].sort());
    assert.equal(hub.job(socialAgain.id).status, "queued", "social is busy: it waits its turn");
    assert.equal(hub.job(engineering.id).status, "queued", "both slots are taken");

    // A call doesn't wait for a slot.
    hub.cancel(engineering.id);
    const call = hub.send("engineering", "on the phone", { kind: "call" });
    assert.equal((await finished(hub, call.id)).status, "done");

    // When a run ends, the next in line starts.
    hub.cancel(social.id);
    assert.equal((await finished(hub, socialAgain.id)).result, "echo: two");
    assert.equal(hub.job(ceo.id).status, "running");
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed turn becomes a note, and a written file triggers the index rebuild", async () => {
  const { root, store, hub, written } = setup();
  try {
    hub.start();
    const failed = await finished(hub, hub.send("social", "FAIL now").id);
    assert.equal(failed.status, "failed");
    assert.equal(hub.messages("social").pop().role, "note");

    await finished(hub, hub.send("social", "WRITE a draft").id);
    assert.equal(written.length, 1);
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thread the user has open is not resumed until they close it", async () => {
  const { root, store, hub, open } = setup();
  try {
    hub.start();
    await finished(hub, hub.send("social", "one").id);
    open.add(store.activeThread("social").sessionId);
    const blocked = hub.send("social", "two");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(hub.job(blocked.id).status, "queued");
    open.clear();
    hub.tick();
    assert.equal((await finished(hub, blocked.id)).status, "done");
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new thread starts a fresh session; a changed definition rotates with a handover", async () => {
  const { root, store, hub, agentsDir } = setup();
  try {
    hub.start();
    await finished(hub, hub.send("social", "remember PELICAN").id);
    const before = store.activeThread("social");

    writeFileSync(join(agentsDir, "social.md"), AGENT_MD("social") + "\nNew rule.\n");
    const job = await finished(hub, hub.send("social", "what was it").id);
    const after = store.activeThread("social");
    assert.notEqual(after.sessionId, before.sessionId);
    assert.equal(store.thread(before.id).rotatedReason, "definition");
    assert.match(job.result, /echo: what was it/);

    hub.newThread("social");
    assert.equal(store.activeThread("social"), undefined);
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the API needs the token and the right host, and exposes the team", async () => {
  const { root, store, hub } = setup();
  const server = createApi(hub, { port: 0, token: "t".repeat(64) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // The host check is configured for port 0 above; rebuild it for the real port.
  server.close();
  const api = createApi(hub, { port, token: "t".repeat(64) });
  await new Promise((r) => api.listen(port, "127.0.0.1", r));
  const call = (path, init = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${"t".repeat(64)}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/agents`)).status, 401);
    assert.equal(
      (await call("/v1/agents", { headers: { authorization: "Bearer wrong" } })).status,
      401,
    );
    const { agents } = await (await call("/v1/agents")).json();
    assert.equal(agents.length, 8);
    assert.equal((await call("/v1/threads/nobody/messages")).status, 404);

    hub.start();
    const { job } = await (
      await call("/v1/threads/ceo/messages", {
        method: "POST",
        body: JSON.stringify({ text: "hi" }),
      })
    ).json();
    const done = await finished(hub, job.id);
    assert.equal(done.result, "echo: hi");
    const { events } = await (await call("/v1/events/poll?since=0")).json();
    assert.ok(events.some((e) => e.type === "job.done"));
  } finally {
    api.close();
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the window's files are public, and its one-time code buys the token once", async () => {
  const { root, store, hub } = setup();
  const token = "t".repeat(64);
  const probe = createApi(hub, { port: 0, token });
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  probe.close();
  const api = createApi(hub, { port, token });
  await new Promise((r) => api.listen(port, "127.0.0.1", r));
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  const post = (path, body, auth) =>
    fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  try {
    const page = await fetch(url("/"));
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.doesNotMatch(await page.text(), new RegExp(token));
    assert.equal((await fetch(url("/faces.mjs"))).status, 200);

    assert.equal((await post("/v1/window/code", {})).status, 401);
    const { code } = await (await post("/v1/window/code", {}, `Bearer ${token}`)).json();
    assert.match(code, /^[A-Za-z0-9_-]{12}$/);

    assert.equal((await post("/v1/window/redeem", { code: "nope" })).status, 401);
    const first = await post("/v1/window/redeem", { code });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).token, token);
    assert.equal((await post("/v1/window/redeem", { code })).status, 401);
  } finally {
    api.close();
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session that already exists is resumed instead of failing", async () => {
  const { root, store, hub } = setup();
  try {
    hub.start();
    const job = await finished(hub, hub.send("social", "INUSE hello").id);
    assert.equal(job.status, "done");
    assert.equal(store.activeThread("social").started, 1);
    assert.ok(store.eventsSince(0).some((e) => e.type === "job.retry"));
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("out of usage, the team cries; one that needs the user still asks", async () => {
  const { root, store, hub } = setup();
  try {
    assert.equal(hub.budget().limit, null);
    assert.ok(hub.agents().every((a) => a.state === "idle"));
    store.set("usage", { fiveHour: 1, sevenDay: 0.3, at: Date.now() });
    assert.equal(hub.budget().limit.which, "five-hour");
    assert.ok(hub.agents().every((a) => a.state === "limit"));
    const job = store.addJob({
      agent: "social",
      kind: "chat",
      priority: 0,
      prompt: "x",
      createdAt: 1,
    });
    store.updateJob(job.id, { status: "running" });
    hub.gateRequest({ jobId: job.id, tool: "Bash", summary: "Run: rm -rf x", reason: "deletes" });
    store.updateJob(job.id, { status: "done", endedAt: Date.now() });
    const states = Object.fromEntries(hub.agents().map((a) => [a.id, a.state]));
    assert.equal(states.social, "asking");
    assert.equal(states.ceo, "limit");
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
