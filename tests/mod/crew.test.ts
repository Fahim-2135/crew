// Tests for the Crew mod (hooks/crew.mjs), run by `claude plugin test` with a fake hub: every
// call the mod makes to the hub's API is answered by the `http.fetch` stub below.

import { expect, mock, test } from "claude-code/testing";

const BAND = {
  plugin: "crew",
  component: "AbovePrompt",
  surface: "terminal",
  viewport: { columns: 160, rows: 60 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const;

const TEAM = ["ceo", "product", "engineering", "growth", "social", "ops", "learning", "coder"];

/** A tiny in-memory hub: what the mod reads, and a log of what it asked for. */
function fakeHub() {
  return {
    up: true,
    agents: TEAM.map((id) => ({ id, state: "idle", asking: 0, queued: 0, lastLine: null })),
    approvals: [] as any[],
    codes: 0,
    calls: [] as Array<{ method: string; path: string; body: any; auth: string }>,
  };
}

type Seen = { toasts: string[]; runs: string[][] };

function stubAll(on, hub, seen: Seen, clock = mock.clock(on)) {
  mock.env(on, { LOCALAPPDATA: "C:/Local" });
  on("fs.read", ($, e) => ({ value: e.path.endsWith("local-token") ? "tok\n" : "" }));
  on("command.register", () => ({ value: undefined }));
  on("ui.toast", ($, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on("process.run", ($, e) => {
    seen.runs.push(e.argv);
    return { value: { exitCode: 0, stdout: "", stderr: "" } };
  });
  on("session.start", () => ({ cwd: "/work" }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
  on("http.fetch", ($, e) => {
    const url = new URL(e.url);
    const method = e.init?.method ?? "GET";
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined;
    hub.calls.push({ method, path: url.pathname, body, auth: e.init?.headers?.authorization });
    if (!hub.up) return { deny: "connection refused" };
    const ok = (data) => ({
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) },
    });
    const path = url.pathname;
    if (path === "/v1/agents") return ok({ agents: hub.agents });
    if (path === "/v1/approvals") return ok({ approvals: hub.approvals });
    if (path === "/v1/window/code") return ok({ code: `code${++hub.codes}` });
    const m = /^\/v1\/approvals\/([A-Z0-9-]+)\/decision$/.exec(path);
    if (m) {
      const a = hub.approvals.find((x) => x.code === m[1]);
      hub.approvals = hub.approvals.filter((x) => x.code !== m[1]);
      return ok({
        approval: {
          ...a,
          status: body.decision === "approve" ? "executed" : "denied",
          result: "done",
        },
      });
    }
    return { value: { status: 404, ok: false, headers: {}, text: '{"error":"no route"}' } };
  });
  return clock;
}

async function start($, on, hub) {
  const seen: Seen = { toasts: [], runs: [] };
  const clock = stubAll(on, hub, seen);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  return { seen, clock };
}

const isWindowLaunch = (argv: string[]) => argv.includes("msedge");

test("/crew opens the Crew window with a one-time code, never the token", async ($, on) => {
  const hub = fakeHub();
  const { seen } = await start($, on, hub);
  const answer = await $.command.run({ command: "crew", args: "" });
  expect(answer.text).toBe("Opened the Crew window.");

  const codeCall = hub.calls.find((c) => c.path === "/v1/window/code");
  expect(codeCall?.method).toBe("POST");
  expect(codeCall?.auth).toBe("Bearer tok");

  const launch = seen.runs.find(isWindowLaunch)!;
  expect(launch.slice(0, 4)).toEqual(["cmd", "/c", "start", ""]);
  expect(launch).toContain("--app=http://127.0.0.1:7788/#code1");
  expect(launch.join(" ")).not.toMatch(/tok/);
  expect(launch.join(" ")).not.toMatch(/&/);
});

test("/crew <agent> opens that agent's chat; an unknown name is refused", async ($, on) => {
  const hub = fakeHub();
  const { seen } = await start($, on, hub);
  expect((await $.command.run({ command: "crew", args: "social" })).text).toBe(
    "Opened Social's chat.",
  );
  expect(seen.runs.find(isWindowLaunch)).toContain("--app=http://127.0.0.1:7788/#code1.social");
  expect((await $.command.run({ command: "crew", args: "nobody" })).text).toMatch(
    /No agent named nobody/,
  );
});

test("with the hub down, /crew starts it and opens the window once it answers", async ($, on) => {
  const hub = fakeHub();
  hub.up = false;
  const { seen, clock } = await start($, on, hub);
  const answer = await $.command.run({ command: "crew", args: "ops" });
  expect(answer.text).toMatch(/^Starting the Crew hub… Ops's chat opens in a moment\.$/);
  expect(seen.runs[0].join(" ")).toMatch(/hub\/bin\/crew\.mjs start$/);
  expect(seen.runs.some(isWindowLaunch)).toBe(false);

  hub.up = true;
  await clock.advance(1000);
  expect(seen.runs.find(isWindowLaunch)).toContain("--app=http://127.0.0.1:7788/#code1.ops");
});

test("a pending approval shows in the band, and /crew approve decides it", async ($, on) => {
  const hub = fakeHub();
  hub.approvals = [
    {
      id: "x",
      code: "A-9RPE",
      agent: "engineering",
      type: "patch.apply",
      summary: "Apply the crash fix",
      payload: { repo: "E:/r" },
      risk: null,
      tainted: false,
    },
  ];
  await start($, on, hub);

  const band = await $.ui.mount(BAND);
  expect(
    await band.find({
      type: "Text",
      text: /crew · Engineering needs you: Apply the crash fix \(A-9RPE\)/,
    }),
  ).toBeDefined();
  await band.unmount();

  const answer = await $.command.run({ command: "crew", args: "approve A-9RPE" });
  expect(answer.text).toBe("A-9RPE: executed — done");
  const decision = hub.calls.find((c) => c.path === "/v1/approvals/A-9RPE/decision");
  expect(decision?.body.decision).toBe("approve");
  expect(typeof decision?.body.nonce).toBe("string");
});

test("a new request raises a toast; the first look at the hub does not", async ($, on) => {
  const hub = fakeHub();
  hub.approvals = [
    { id: "old", code: "A-2222", agent: "ops", type: "post", summary: "old", payload: {} },
  ];
  const { seen, clock } = await start($, on, hub);
  expect(seen.toasts).toEqual([]);
  hub.approvals = [
    ...hub.approvals,
    {
      id: "new",
      code: "A-3333",
      agent: "social",
      type: "post",
      summary: "Post the launch line",
      payload: {},
    },
  ];
  await clock.advance(3000);
  expect(seen.toasts).toEqual(["Social needs you: Post the launch line"]);
});

test("an agent that finishes raises a toast", async ($, on) => {
  const hub = fakeHub();
  hub.agents = hub.agents.map((a) => (a.id === "growth" ? { ...a, state: "working" } : a));
  const { seen, clock } = await start($, on, hub);
  hub.agents = hub.agents.map((a) => (a.id === "growth" ? { ...a, state: "done" } : a));
  await clock.advance(3000);
  expect(seen.toasts).toEqual(["Growth replied. /crew growth"]);
});

test("the mod stays silent inside a Crew worker run", async ($, on) => {
  mock.env(on, { CREW_WORKER: "1" });
  on("session.start", () => ({ cwd: "/work" }));
  await $.session.start({ surface: "terminal", isInteractive: false, cwd: "/work" });
  expect((await $.command.run({ command: "crew", args: "" })).text).toBe(
    "Crew is off in this session.",
  );
});

test("agents the user created open by name, with their own title", async ($, on) => {
  const hub = fakeHub();
  hub.agents = [
    ...hub.agents,
    { id: "reviews", title: "Reviews", state: "idle", asking: 0, queued: 0, lastLine: null } as any,
  ];
  const { seen } = await start($, on, hub);
  expect((await $.command.run({ command: "crew", args: "reviews" })).text).toBe(
    "Opened Reviews's chat.",
  );
  expect(seen.runs.find(isWindowLaunch)).toContain("--app=http://127.0.0.1:7788/#code1.reviews");
});
