#!/usr/bin/env node
// `crew`: run the hub, or talk to a running hub from the terminal.
//
//   crew setup --name N --focus F  set up a new Crew: brain, starter team, autostart, shortcut
//   crew start                     run the hub in this terminal (a second start exits quietly)
//   crew run                       run the hub and restart it if it crashes (what autostart uses)
//   crew open [agent]              open the Crew window (the team, and each agent's chat)
//   crew status                    the team, what each agent is doing, and the budget
//   crew send <agent> <message>    message an agent and wait for the reply
//   crew thread <agent> [n]        the last n messages with an agent (default 10)
//   crew new <agent>               start the agent's next message in a fresh session
//   crew cancel <job>              stop one job
//   crew report [now]              today's morning report (`now` builds a fresh one)
//   crew off | on                  the kill switch: stop everything and hold it, or carry on
//   crew autostart on | off        start the hub (hidden) whenever the user signs in to Windows
//   crew approvals                 requests waiting for the user
//   crew approve <code>            approve one (Crew carries it out)
//   crew deny <code> [note]        say no, optionally with a note for the agent
//   crew remote on | off           let paired phones reach the hub over Tailscale (HTTPS)
//   crew pair                      show a code to pair the Crew phone app (valid 5 minutes)
//   crew phones                    paired phones
//   crew unpair <id>               cut a phone off (lost phone, new phone)
//   crew face install | on | off  claude-face: install it (Crew agents only), or switch it on or off
//   crew notify <title> <message>  tell the user something (desktop notification + the window)
//   crew browser setup             install the agent browser and register it with Claude Code
//   crew desktop setup             let agents see and use this PC's desktop (computer use)
//   crew browser [url...]          sign in to sites for the agents (LinkedIn, Play Console, AdMob…)

import { spawn, spawnSync } from "node:child_process";
import { openOnPc, openUrl, readPreview } from "../src/io/files.mjs";
import { setupBrowser, signIn } from "../src/io/browser.mjs";
import { faceStatus, installFace, setFace } from "../src/io/face.mjs";
import { notifyDesktop } from "../src/io/notify.mjs";
import {
  autostartIsOn,
  makeShortcut,
  openAppWindow,
  registerAppId,
  setAutostart,
} from "../src/io/platform.mjs";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applyConfig, crewPaths, ensureDirs, localToken } from "../src/io/paths.mjs";

const paths = crewPaths();
const [command, ...rest] = process.argv.slice(2);

const off = () =>
  post("/v1/stop-all").then(() => console.log("Crew is off. `crew on` to carry on."));
const on = () => post("/v1/resume-all").then(() => console.log("Crew is on."));

const COMMANDS = {
  start,
  run: supervise,
  open: openWindow,
  status,
  send: sendMessage,
  thread,
  new: newThread,
  cancel,
  report,
  off,
  on,
  "stop-all": off,
  "resume-all": on,
  autostart,
  setup,
  approvals,
  approve: (code) => decideOn(code, "approve"),
  deny: (code, ...note) => decideOn(code, "deny", note.join(" ")),
  remote,
  pair,
  phones,
  unpair,
  browser,
  desktop,
  face: async (sub) => {
    if (sub === "install") {
      const { version } = await installFace({ crewOnly: true });
      console.log(
        `claude-face ${version} is installed and shows your Crew agents. Turn it on or off from the face button in the Crew window.`,
      );
    } else if (sub === "on" || sub === "off") console.log(await setFace(sub === "on"));
    else console.log(await faceStatus());
  },
  notify: (title, ...body) =>
    post("/v1/notify", { title, body: body.join(" ") }).then(() => console.log("Told them.")),
};

/** The agent browser: `setup` installs it; otherwise open Chrome to sign in for the agents. */
async function browser(sub, ...more) {
  ensureDirs(paths);
  if (sub === "setup") return setupBrowser(paths.home);
  // The user may be looking at the Crew window, not a terminal: tell them what this window is.
  await post("/v1/notify", {
    title: "Sign in for your agents",
    body: "A Chrome window opened. Sign in to the sites there, then close it.",
  }).catch(() => {});
  const { cookies, sites } = await signIn(paths.home, sub ? [sub, ...more] : undefined);
  console.log(
    `Saved ${cookies} cookies${sites.length ? ` (signed in: ${sites.join(", ")})` : ""}. The agents use them from their next run.`,
  );
}

/** Computer use on this PC: register the desktop tool with Claude Code (user scope). */
async function desktop(sub) {
  if (sub !== "setup") {
    console.log("usage: crew desktop setup");
    return;
  }
  const { findClaude } = await import("../src/io/claude.mjs");
  const claude = findClaude();
  const server = fileURLToPath(new URL("../src/io/mcp-desktop.mjs", import.meta.url));
  const entry = JSON.stringify({ type: "stdio", command: "node", args: [server] });
  spawnSync(claude, ["mcp", "remove", "--scope", "user", "desktop"], { stdio: "ignore" });
  const add = spawnSync(claude, ["mcp", "add-json", "--scope", "user", "desktop", entry], {
    stdio: "inherit",
  });
  if (add.status !== 0) throw new Error("couldn't register the desktop tool with Claude Code");
  console.log("Agents can now see and use this PC's desktop (with the takeover rules).");
}

async function main() {
  try {
    const run = COMMANDS[command];
    if (!run) {
      console.log(
        "usage: crew setup [--name N] [--focus F] | start | open [agent] | status | send <agent> <message> | thread <agent> [n] | new <agent> | cancel <job> | report [now] | off | on | autostart on|off | approvals | approve <code> | deny <code> [note] | remote on|off | pair | phones | unpair <id> | browser [setup | url...] | desktop setup",
      );
      process.exitCode = command ? 1 : 0;
    } else {
      await run(...rest);
    }
  } catch (err) {
    console.error(`crew: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

// --- the hub

async function start() {
  const { Store } = await import("../src/io/store.mjs");
  const { Hub } = await import("../src/hub.mjs");
  const { createApi } = await import("../src/io/http.mjs");
  const { findClaude, runTurn, runScript, listSessions, killTree } =
    await import("../src/io/claude.mjs");
  const { execute, capturePreconditions } = await import("../src/io/executors.mjs");
  const { scanInboxes, watchInboxes } = await import("../src/io/watch.mjs");
  const { resolveConfig } = await import("../src/core/config.mjs");
  const { fcmSender } = await import("../src/io/fcm.mjs");
  const { createAgent, updateAgent, definitionHash } = await import("../src/io/team.mjs");
  const { commitRun } = await import("../src/io/brain-git.mjs");
  const { readTranscript } = await import("../src/io/transcripts.mjs");

  ensureDirs(paths);
  const token = localToken(paths);
  const configFile = join(paths.home, "config.json");
  const config = resolveConfig(
    existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null,
  );
  applyConfig(paths, config);
  const store = new Store(paths.db);
  const logFile = join(paths.logs, `hub-${new Date().toISOString().slice(0, 10)}.log`);
  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    appendFileSync(logFile, stamped + "\n");
  };

  const hub = new Hub({
    store,
    paths,
    config,
    workDirs: workingDirs(),
    readTranscript,
    bin: findClaude(),
    runTurn,
    runScript,
    sessions: listSessions,
    scanInboxes,
    killTree,
    execute,
    capturePreconditions,
    push: fcmSender(join(paths.home, "firebase-key.json")),
    createAgent,
    updateAgent,
    definitionHash,
    face: { status: faceStatus, set: setFace },
    notify: notifyDesktop,
    openPath: openOnPc,
    openUrl,
    readPreview,
    // "Open in terminal": the agent's own Claude Code conversation, in a new console window.
    openTerminal: ({ agent, title, sessionId, cwd }) => {
      spawn(
        "cmd",
        ["/c", "start", title, "/D", cwd, "claude", "--resume", sessionId, "--agent", agent],
        { detached: true, stdio: "ignore", windowsHide: false },
      ).unref();
    },
    afterWrite: (run) => {
      // A brain with its own index builder (the user's) gets it rebuilt; a Crew brain has none.
      const indexer = join(paths.brain, "tools", "build-index.mjs");
      if (existsSync(indexer)) {
        const out = spawnSync(process.execPath, [indexer], {
          cwd: paths.brain,
          encoding: "utf8",
          windowsHide: true,
          timeout: 60_000,
        });
        log(out.status === 0 ? "brain index rebuilt" : `brain index rebuild failed: ${out.stderr}`);
      }
      // Commit what this run wrote (a brain's own git hook may scan it for secrets first).
      if (run?.files?.length && existsSync(join(paths.brain, ".git"))) {
        const done = commitRun(
          paths.brain,
          run.files,
          `brain: crew ${run.agent} (${run.kind} job ${run.jobId})`,
        );
        log(done.ok ? `brain commit: ${done.detail}` : `brain commit refused: ${done.detail}`);
        if (!done.ok)
          hub.event("brain.commit", { ok: false, agent: run.agent, detail: done.detail });
      }
    },
  });
  hub.on("event", (e) => log(`${e.type} ${JSON.stringify(e.data)}`));

  const remoteHost = tailscaleName();
  const server = createApi(hub, {
    port: paths.port,
    token,
    remoteHost,
    findRemoteHost: tailscaleName,
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`crew hub is already running on port ${paths.port}`);
      store.close();
      process.exit(0);
    }
    throw err;
  });

  let stopWatching = () => {};
  let scheduler = null;
  server.listen(paths.port, "127.0.0.1", () => {
    log(`crew hub on http://127.0.0.1:${paths.port} (state in ${paths.home})`);
    if (remoteHost) log(`phones reach it at https://${remoteHost} (with \`crew remote on\`)`);
    if (!hub.pushFn) log("no firebase-key.json yet: phones get no notifications");
    hub.start();
    // The supervisor leaves a note when the last hub crashed: tell the user's phone.
    const crashedFile = join(paths.home, "crashed.json");
    if (existsSync(crashedFile)) {
      const { code } = JSON.parse(readFileSync(crashedFile, "utf8"));
      rmSync(crashedFile, { force: true });
      hub.event("alert", { kind: "hub", text: `The hub crashed (exit ${code}) and restarted.` });
    }
    hub.inboxTick();
    hub.schedulerTick();
    stopWatching = watchInboxes(paths.brain, () => hub.inboxTick());
    scheduler = setInterval(() => {
      hub.schedulerTick();
      hub.approvalsTick();
    }, 60_000);
  });

  const shutdown = async () => {
    log("crew hub stopping");
    clearInterval(scheduler);
    stopWatching();
    server.close();
    await hub.shutdown();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // `crew setup` after an update: stop cleanly; the supervisor (`crew run`) starts the new code.
  hub.on("restart", () => {
    log("crew hub restarting for an update");
    clearInterval(scheduler);
    stopWatching();
    server.close();
    hub.shutdown().then(() => {
      store.close();
      process.exit(75);
    });
  });
  process.on("uncaughtException", (err) => {
    log(`crash: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

/**
 * Run the hub as a child and start it again if it dies with an error, backing off, and giving
 * up after six crashes in ten minutes. A clean stop (or "already running") ends it. Signing out
 * of Windows ends both, so that never counts as a crash.
 */
async function supervise() {
  ensureDirs(paths);
  const crashes = [];
  let stopping = false;
  let child = null;
  const stop = () => {
    stopping = true;
    child?.kill("SIGINT");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  for (;;) {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start"], {
      stdio: "inherit",
      windowsHide: true,
    });
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
    if (stopping || code === 0) return;
    // 75: the hub asked to restart on new code (`crew setup`, /v1/restart). Not a crash.
    if (code === 75) continue;
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 10 * 60_000) crashes.shift();
    writeFileSync(join(paths.home, "crashed.json"), JSON.stringify({ at: now, code }));
    if (crashes.length > 5) {
      console.error("crew: the hub keeps crashing; giving up. See the logs folder.");
      process.exitCode = 1;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** (crashes.length - 1))));
  }
}

// --- the window

/**
 * Bring the open Crew window to the front (Windows): the Edge app window titled "Crew". A tap
 * of Alt first, because Windows only lets the app with the latest input take the foreground.
 */
function focusCrewWindow() {
  if (process.platform !== "win32") return;
  const script = `
Add-Type @"
using System; using System.Text; using System.Diagnostics; using System.Runtime.InteropServices;
public class CW {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static bool Focus() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.ToString() != "Crew") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      try { if (Process.GetProcessById((int)pid).ProcessName != "msedge") return true; } catch { return true; }
      found = h; return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(found);
  }
}
"@
[void][CW]::Focus()`;
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: "ignore" },
  );
}

/**
 * Open the Crew window as an app window (Edge's app mode: no tabs or address bar). The link
 * carries a one-time code that the page trades for the key, so the key never appears in an
 * address bar or browser history.
 */
async function openWindow(agent) {
  if (!(await hubAnswers())) {
    // Start the hub hidden, on its own, and give it a few seconds to come up.
    spawn(process.execPath, [fileURLToPath(import.meta.url), "run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    for (let i = 0; i < 30 && !(await hubAnswers()); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  // A window is already open: show the agent there and bring it to the front.
  const { shown } = await post("/v1/window/show", agent ? { agent } : {});
  if (shown) {
    focusCrewWindow();
    console.log("Crew window shown.");
    return;
  }
  const { code } = await post("/v1/window/code");
  // `<code>.<agent>`: nothing in it means anything to cmd's `start`, which splits a URL at `&`.
  const url = `http://127.0.0.1:${paths.port}/#${code}${agent ? `.${agent}` : ""}`;
  openAppWindow(url);
  console.log("Crew window opened.");
}

async function hubAnswers() {
  try {
    return (await fetch(`http://127.0.0.1:${paths.port}/v1/health`)).ok;
  } catch {
    return false;
  }
}

/**
 * Folders an agent may work in besides the brain: every drive on Windows, the home folder on a
 * Mac or Linux. ("Read and work anywhere", as in the terminal with all drives added.)
 */
function workingDirs() {
  if (process.platform !== "win32") return [process.env.HOME ?? "/"];
  const drives = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (existsSync(`${letter}:/`)) drives.push(`${letter}:/`);
  }
  return drives;
}

// --- phones

/** This PC's Tailscale name (laptop.tailnet.ts.net), or null without Tailscale. */
function tailscaleName() {
  const out = spawnSync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (out.status !== 0) return null;
  try {
    return JSON.parse(out.stdout).Self?.DNSName?.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/** `tailscale serve`: HTTPS on this PC's Tailscale name, private to the user's own devices. */
function remote(mode) {
  const name = tailscaleName();
  if (!name) throw new Error("Tailscale is not running on this PC");
  const args =
    mode === "on"
      ? ["serve", "--bg", "--https=443", `http://127.0.0.1:${paths.port}`]
      : mode === "off"
        ? ["serve", "--https=443", "off"]
        : ["serve", "status"];
  const out = spawnSync("tailscale", args, { encoding: "utf8", windowsHide: true });
  const said = `${out.stdout ?? ""}${out.stderr ?? ""}`.trim();
  if (out.status !== 0) throw new Error(said || `tailscale ${args.join(" ")} failed`);
  if (mode === "on") console.log(`Phones can reach Crew at https://${name}`);
  else if (mode === "off") console.log("Phones can no longer reach Crew.");
  else console.log(said);
}

async function pair() {
  const { code, expiresAt, hubUrl } = await post("/v1/pair/start");
  console.log(`In the Crew app, enter:

  Hub:  ${hubUrl ?? "(Tailscale isn't running on this PC)"}
  Code: ${code.slice(0, 4)} ${code.slice(4)}
`);
  console.log(`The code works once, until ${new Date(expiresAt).toLocaleTimeString()}.`);
}

async function phones() {
  const { devices } = await api("/v1/devices");
  if (!devices.length) {
    console.log("No phones paired. `crew pair` to add one.");
    return;
  }
  for (const d of devices) {
    const seen = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "never";
    const state = d.revoked ? "cut off" : d.push ? "notifications on" : "no notifications";
    console.log(`${d.id}  ${d.name}  (${state}; last seen ${seen})`);
  }
}

async function unpair(id) {
  if (!id) throw new Error("usage: crew unpair <id>   (ids from `crew phones`)");
  const { devices } = await api("/v1/devices");
  const match = devices.filter((d) => d.id.startsWith(id));
  if (match.length !== 1)
    throw new Error(match.length ? "that id matches more than one phone" : "no such phone");
  await post(`/v1/devices/${match[0].id}/revoke`);
  console.log(`${match[0].name} is cut off.`);
}

// --- start at sign-in

/** A hidden launcher in the Windows Startup folder: no admin rights, no console window. */
function autostart(mode) {
  const crew = fileURLToPath(import.meta.url);
  if (mode === "on") {
    const where = setAutostart(true, crew);
    console.log(`Crew will start when you sign in (${where}).`);
  } else if (mode === "off") {
    setAutostart(false, crew);
    console.log("Crew will no longer start at sign-in.");
  } else {
    console.log(autostartIsOn() ? "autostart is on" : "autostart is off");
  }
}

// --- setup

/**
 * `crew setup --name "Maya" --focus "what they work on"`: everything a new Crew needs, run by
 * Claude Code from the plugin's /crew:setup. Safe to run again; it keeps what exists.
 */
async function setup(...argv) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name) => argv.includes(`--${name}`);
  // `crew setup --check`: is Crew already set up here? (/crew:setup asks before its questions.)
  if (has("check")) {
    const file = join(paths.home, "config.json");
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    const installed =
      Boolean(settings) && existsSync(join(paths.home, "app", "hub", "bin", "crew.mjs"));
    console.log(
      JSON.stringify({
        installed,
        owner: settings?.owner ?? null,
        hubRunning: await hubAnswers(),
        next: installed
          ? "update: run `setup` with no --name or --focus"
          : "new: ask the two questions, then run `setup --name … --focus …`",
      }),
    );
    return;
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`Crew needs Node.js 22.5 or newer (this is ${process.versions.node})`);
  }
  const { findClaude } = await import("../src/io/claude.mjs");
  findClaude();
  const { createBrain, writeSettings } = await import("../src/io/setup.mjs");
  const { resolveConfig } = await import("../src/core/config.mjs");

  ensureDirs(paths);
  const owner = (flag("name") ?? "").trim();
  const settings = {
    ...(owner ? { owner } : {}),
    ...(flag("brain") ? { brain: flag("brain") } : {}),
  };
  const configFile = writeSettings(paths.home, settings);
  const config = resolveConfig(JSON.parse(readFileSync(configFile, "utf8")));
  applyConfig(paths, config);

  const today = new Date().toISOString().slice(0, 10);
  const brain = createBrain({
    brainDir: paths.brain,
    agentsDir: paths.agentsDir,
    owner: config.owner ?? "",
    focus: flag("focus") ?? "",
    prefix: config.agentPrefix ?? "",
    today,
  });
  console.log(
    `Brain: ${paths.brain} (${brain.created.length ? `new agents: ${brain.created.join(", ")}` : "already set up"})`,
  );

  // Run from a copy in Crew's own folder: the plugin's folder changes with every update.
  const { installApp } = await import("../src/io/install.mjs");
  const { cli: crew, copied } = installApp(paths.home);
  if (copied) console.log(`Installed: ${dirname(dirname(dirname(crew)))}`);
  if (!has("no-autostart")) console.log(`Starts with your computer: ${setAutostart(true, crew)}`);
  if (!has("no-shortcut")) {
    const icon = join(dirname(dirname(crew)), "web", "crew.ico");
    const link = makeShortcut({ crewCli: crew, home: paths.home, icon });
    if (link) console.log(`Desktop shortcut: ${link}`);
  }
  // Windows shows notifications only from apps it knows: a Start menu entry gives Crew its own.
  if (process.platform === "win32") {
    const icon = join(dirname(dirname(crew)), "web", "crew.ico");
    console.log(`Start menu: ${registerAppId({ crewCli: crew, home: paths.home, icon })}`);
  }

  // A hub already running (an earlier version) restarts on the new code; otherwise start one.
  if (await hubAnswers()) {
    if (copied) {
      await post("/v1/restart").catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  for (let i = 0; i < 20 && !(await hubAnswers()); i++) {
    if (i === 0) {
      spawn(process.execPath, [crew, "run"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await hubAnswers()))
    throw new Error("the hub didn't start: see the logs folder in " + paths.home);
  if (!has("no-open")) {
    spawnSync(process.execPath, [crew, "open"], { stdio: "inherit", windowsHide: true });
  }
  console.log("Crew is ready.");
}

// --- the client

async function api(path, init = {}) {
  const res = await fetch(`http://127.0.0.1:${paths.port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${localToken(paths)}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  }).catch(() => {
    throw new Error("the hub is not running (start it with `crew start`)");
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

const STATE_MARK = { idle: "·", working: "…", asking: "?", done: "✓" };

async function status() {
  const [{ agents }, budget] = await Promise.all([api("/v1/agents"), api("/v1/budget")]);
  for (const a of agents) {
    const queued = a.queued ? ` (+${a.queued} queued)` : "";
    console.log(
      `${STATE_MARK[a.state] ?? " "} ${a.id.padEnd(12)} ${a.state.padEnd(8)}${queued}  ${a.lastLine ?? ""}`,
    );
  }
  const u = budget.usage;
  const pct = (x) => (x == null ? "?" : `${Math.round(x * 100)}%`);
  const notes = [
    budget.paused ? "OFF (crew on)" : null,
    budget.quiet ? `quiet: ${budget.quiet}` : null,
    `${budget.autonomousToday} autonomous runs today`,
  ].filter(Boolean);
  console.log(
    `\nplan use: 5-hour ${pct(u?.fiveHour)} · weekly ${pct(u?.sevenDay)} · ${notes.join(" · ")}`,
  );
}

async function sendMessage(agent, ...words) {
  if (!agent || !words.length) throw new Error("usage: crew send <agent> <message>");
  const { job } = await post(`/v1/threads/${agent}/messages`, { text: words.join(" ") });
  process.stdout.write(`${agent} is working`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const { job: now } = await api(`/v1/jobs/${job.id}`);
    if (now.status === "queued" || now.status === "running") {
      process.stdout.write(".");
      continue;
    }
    process.stdout.write("\n\n");
    if (now.status === "done") console.log(now.result);
    else console.log(`(${now.status}: ${now.error ?? "no reason given"})`);
    return;
  }
}

async function thread(agent, n = "10") {
  if (!agent) throw new Error("usage: crew thread <agent> [n]");
  const { messages } = await api(`/v1/threads/${agent}/messages?limit=${Number(n)}`);
  for (const m of messages) {
    const who = m.role === "you" ? "you" : m.role === "agent" ? agent : "crew";
    console.log(`\n${who}:\n${m.text}`);
  }
}

async function newThread(agent) {
  if (!agent) throw new Error("usage: crew new <agent>");
  await post(`/v1/threads/${agent}/new`);
  console.log(`${agent}'s next message starts a fresh session.`);
}

async function cancel(id) {
  const { job } = await post(`/v1/jobs/${Number(id)}/cancel`);
  console.log(`job ${job.id}: ${job.status}`);
}

async function report(arg) {
  const { report: r } = arg === "now" ? await post("/v1/report") : await api("/v1/report");
  if (!r) {
    console.log("No report yet today. `crew report now` builds one.");
    return;
  }
  console.log(`Crew report, ${r.date}:`);
  for (const line of r.lines) console.log(`- ${line}`);
}

async function approvals() {
  const { approvals: list } = await api("/v1/approvals?status=pending");
  if (!list.length) {
    console.log("Nothing is waiting for you.");
    return;
  }
  for (const a of list) {
    const flags = [a.tainted ? "FROM EMAIL" : null, a.risk ? `RISK: ${a.risk}` : null].filter(
      Boolean,
    );
    console.log(
      `\n${a.code}  ${a.agent}  ${a.type}${flags.length ? `  [${flags.join("; ")}]` : ""}`,
    );
    console.log(`  ${a.summary}`);
    if (a.why) console.log(`  why: ${a.why}`);
    for (const [k, v] of Object.entries(a.payload)) {
      console.log(`  ${k}: ${String(v).slice(0, 300)}`);
    }
  }
  console.log("\ncrew approve <code>   |   crew deny <code> [note]");
}

async function decideOn(code, decision, note) {
  if (!code) throw new Error(`usage: crew ${decision} <code>`);
  const { approval: a } = await post(`/v1/approvals/${code}/decision`, {
    decision,
    nonce: randomUUID(),
    note: note || undefined,
  });
  console.log(`${a.code}: ${a.status}${a.result ? `\n${a.result}` : ""}`);
}

// Run last, so every module-level constant above is initialised first.
await main();
