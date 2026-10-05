// Running Claude Code: locating the binary, running one headless turn with a parsed event
// stream, killing a run with everything it started, and listing the sessions the user has open.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseStreamLine } from "../core/stream.mjs";

/**
 * The Claude Code executable. The npm install puts a `.cmd` shim on PATH; spawning the real
 * `claude.exe` behind it (with shell: false) is what gives Crew a pid it can kill.
 * `CREW_CLAUDE_BIN` overrides it, for tests (a `.mjs` file runs under this Node).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function findClaude(env = process.env) {
  if (env.CREW_CLAUDE_BIN) return env.CREW_CLAUDE_BIN;
  const candidates = [
    env.APPDATA && join(env.APPDATA, "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
    env.USERPROFILE && join(env.USERPROFILE, ".local/bin/claude.exe"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? "claude";
}

/** `[command, args]` for a binary, running `.mjs` test doubles under this Node. */
function command(bin, args) {
  return bin.endsWith(".mjs") ? [process.execPath, [bin, ...args]] : [bin, args];
}

/** Kill a process and every process it started. */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Start one headless turn. Events are delivered as they stream; the promise settles when the
 * process exits.
 * @param {{ bin: string, args: string[], prompt: string, cwd: string, timeoutMs: number,
 *   env?: NodeJS.ProcessEnv, onEvent: (event: import("../core/stream.mjs").StreamEvent) => void }} run
 * @returns {{ pid: number | undefined, kill: () => void,
 *   done: Promise<{ code: number | null, killed: boolean, timedOut: boolean, stderr: string }> }}
 */
export function runTurn(run) {
  const [cmd, args] = command(run.bin, run.args);
  const child = spawn(cmd, args, {
    cwd: run.cwd,
    env: run.env ?? process.env,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let killed = false;
  let timedOut = false;
  let stderr = "";
  const kill = () => {
    if (killed) return;
    killed = true;
    killTree(child.pid);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, run.timeoutMs);

  child.stderr.on("data", (d) => {
    if (stderr.length < 4000) stderr += d;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    for (const event of parseStreamLine(line)) run.onEvent(event);
  });
  child.stdin.on("error", () => {
    /* the process may exit before reading its prompt */
  });
  child.stdin.end(run.prompt);

  const done = new Promise((resolveDone) => {
    const finish = (code) => {
      clearTimeout(timer);
      resolveDone({ code, killed, timedOut, stderr });
    };
    child.on("error", (err) => {
      stderr += String(err?.message ?? err);
      finish(null);
    });
    child.on("close", finish);
  });

  return { pid: child.pid, kill, done };
}

/**
 * The Claude Code sessions currently open, from `claude agents --json`. A Crew thread whose
 * session is open must not be resumed at the same time (both processes would append to one
 * transcript), and a busy interactive session means the user is working.
 * @param {string} bin
 * @returns {Array<{ sessionId: string, kind: string, status: string }>}
 */
export function listSessions(bin) {
  const [cmd, args] = command(bin, ["agents", "--json"]);
  const out = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  try {
    const list = JSON.parse(out.stdout || "[]");
    return (Array.isArray(list) ? list : []).map((s) => ({
      sessionId: String(s.sessionId),
      kind: String(s.kind ?? ""),
      status: String(s.status ?? ""),
    }));
  } catch {
    return [];
  }
}

/**
 * Run a brain script under this Node (the mailroom), killable like a turn.
 * @param {{ script: string, cwd: string, timeoutMs: number }} run
 */
export function runScript(run) {
  const child = spawn(process.execPath, [run.script], {
    cwd: run.cwd,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let killed = false;
  let timedOut = false;
  let stdout = "";
  let stderr = "";
  const kill = () => {
    if (killed) return;
    killed = true;
    killTree(child.pid);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, run.timeoutMs);
  child.stdout.on("data", (d) => {
    stdout = (stdout + d).slice(-4000);
  });
  child.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  const done = new Promise((resolveDone) => {
    const finish = (code) => {
      clearTimeout(timer);
      resolveDone({ code, killed, timedOut, stdout, stderr });
    };
    child.on("error", (err) => {
      stderr += String(err?.message ?? err);
      finish(null);
    });
    child.on("close", finish);
  });
  return { pid: child.pid, kill, done };
}
