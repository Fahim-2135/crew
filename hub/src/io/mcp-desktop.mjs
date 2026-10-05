#!/usr/bin/env node
// The `desktop` MCP server: an agent's eyes and hands on the user's own Windows desktop, for the
// work only a real screen can do (desktop apps, recording the screen for a clip). Registered
// for the user, so Crew runs and the terminal get the same tools. Zero dependencies:
// newline-delimited JSON-RPC 2.0 on stdin/stdout, like mcp-crew.mjs; the Windows side is
// desktop-host.ps1.
//
// Taking over the mouse and keyboard (core/desktop.mjs): in a Crew run, straight away if the user
// has been away 5 minutes, otherwise only with their quick OK; then a banner counts down 5 s, and
// moving the mouse at any point hands the PC back and stops the agent. Recording the screen
// asks the same way. The banner never shows in screenshots or recordings.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  COUNTDOWN_S,
  SHOT_WIDTH,
  findWindow,
  parseKeys,
  parseWindows,
  recordArgs,
  takeover,
  toScreen,
  tookBack,
} from "../core/desktop.mjs";
import { askOwner } from "./quick-ok.mjs";
import { Owner, owners } from "../core/owner.mjs";

const IDLE_RELEASE_MS = 2 * 60_000;
const MAX_RECORDING_MS = 15 * 60_000;
const SHOTS = join(tmpdir(), "crew-desktop");
const VIDEOS = join(homedir(), "Videos", "Crew");
const inCrew = Boolean(process.env.CREW_JOB);
const who = process.env.CREW_AGENT
  ? process.env.CREW_AGENT[0].toUpperCase() + process.env.CREW_AGENT.slice(1)
  : "Claude";

// --- the Windows host

let host = null;
const pending = new Map();
let nextId = 0;
function startHost() {
  const ps = spawn(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./desktop-host.ps1", import.meta.url)),
    ],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  let ready;
  const started = new Promise((r) => (ready = r));
  createInterface({ input: ps.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.ready) return ready();
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (!waiter) return;
    if (msg.ok) waiter.resolve(msg.result ?? {});
    else waiter.reject(new Error(msg.error));
  });
  ps.on("exit", () => {
    host = null;
    for (const w of pending.values()) w.reject(new Error("the desktop helper stopped"));
    pending.clear();
  });
  return { ps, started };
}
async function win(op, args = {}) {
  host ??= startHost();
  await host.started;
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.ps.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const banner = (text) => win("banner", { text: text ?? "" });

// --- taking over

/** @type {{ granted: boolean, leftAt: number[] | null, timer: NodeJS.Timeout | null }} */
const control = { granted: false, leftAt: null, timer: null };
let recordOk = false;
let lastShot = null;

class Stop extends Error {}

function release() {
  control.granted = false;
  control.leftAt = null;
  clearTimeout(control.timer);
  if (!recording) banner(null).catch(() => {});
}

async function consent(what) {
  const { idleMs } = await win("idle");
  if (takeover({ inCrew, idleMs }) === "go") return;
  const answer = await askOwner({
    tool: "desktop",
    summary: `${who} wants to ${what}`,
    reason: what.startsWith("record")
      ? "records your screen"
      : "takes over your mouse and keyboard",
  });
  if (!answer.allow) throw new Stop(answer.reason);
}

/** Before any mouse or keyboard input: take over (once), or notice the user took it back. */
async function ensureControl(what) {
  if (control.granted) {
    const { cursor } = await win("cursor");
    if (tookBack(control.leftAt, cursor)) {
      release();
      throw new Stop(
        `${Owner()} moved the mouse, so the PC is theirs again. Don't take it back on your own: tell them where you got to and what is left.`,
      );
    }
  } else {
    await consent(`use your mouse and keyboard to ${what}`);
    const start = (await win("cursor")).cursor;
    for (let s = COUNTDOWN_S; s > 0; s--) {
      await banner(`Crew · ${who} takes over your mouse in ${s}…  move it to stop`);
      await sleep(1000);
      if (tookBack(start, (await win("cursor")).cursor)) {
        await banner(recording ? recordingLine() : null);
        throw new Stop(
          `${Owner()} moved the mouse during the countdown: they are using the PC. Stop, and tell them what you were about to do.`,
        );
      }
    }
    await banner(`Crew · ${who} is using your PC  ·  move the mouse to stop`);
    control.granted = true;
    control.leftAt = start;
  }
  clearTimeout(control.timer);
  control.timer = setTimeout(release, IDLE_RELEASE_MS);
  control.timer.unref?.();
}
const settle = async () => {
  await sleep(250);
  control.leftAt = (await win("cursor")).cursor;
};

// --- recording

/** @type {{ proc: import("node:child_process").ChildProcess, path: string, startedAt: number, timer: NodeJS.Timeout } | null} */
let recording = null;
const recordingLine = () => `● Crew · ${who} is recording your screen`;

async function stopRecording() {
  if (!recording) throw new Error("nothing is being recorded");
  const r = recording;
  recording = null;
  clearTimeout(r.timer);
  const done = new Promise((resolve) => r.proc.on("exit", resolve));
  r.proc.stdin.write("q");
  r.proc.stdin.end();
  await Promise.race([done, sleep(10_000).then(() => r.proc.kill())]);
  await banner(
    control.granted ? `Crew · ${who} is using your PC  ·  move the mouse to stop` : null,
  );
  let size = 0;
  try {
    size = statSync(r.path).size;
  } catch {
    /* reported below */
  }
  if (!size) throw new Error(`the recording failed${r.errors ? `: ${r.errors.slice(-300)}` : ""}`);
  return {
    path: r.path,
    seconds: Math.round((Date.now() - r.startedAt) / 1000),
    mb: +(size / 1e6).toFixed(1),
  };
}

// --- the tools

const point = { x: { type: "number" }, y: { type: "number" } };
const TOOLS = [
  {
    name: "screenshot",
    description: `See ${owners()} screen (or one window, by title). Coordinates for click, move, drag and scroll are read from the latest screenshot. Take a fresh one after anything changes.`,
    inputSchema: {
      type: "object",
      properties: {
        window: {
          type: "string",
          description: "Part of a window title; omit for the whole screen",
        },
      },
    },
  },
  {
    name: "list_windows",
    description: "The open windows, front to back: title, app, position, and whether minimized.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "focus_window",
    description: "Bring a window to the front (restoring it if minimized). Takes over the PC.",
    inputSchema: {
      type: "object",
      properties: { window: { type: "string" } },
      required: ["window"],
    },
  },
  {
    name: "click",
    description: "Click at a point on the latest screenshot. Takes over the PC.",
    inputSchema: {
      type: "object",
      properties: {
        ...point,
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "move",
    description: "Move the mouse to a point on the latest screenshot (hover). Takes over the PC.",
    inputSchema: { type: "object", properties: point, required: ["x", "y"] },
  },
  {
    name: "drag",
    description: "Drag from one point to another on the latest screenshot. Takes over the PC.",
    inputSchema: {
      type: "object",
      properties: { ...point, to_x: { type: "number" }, to_y: { type: "number" } },
      required: ["x", "y", "to_x", "to_y"],
    },
  },
  {
    name: "scroll",
    description:
      "Scroll at a point: amount in wheel notches, positive up, negative down. Takes over the PC.",
    inputSchema: {
      type: "object",
      properties: { ...point, amount: { type: "number" } },
      required: ["x", "y", "amount"],
    },
  },
  {
    name: "type",
    description: "Type text into whatever has focus (newlines press Enter). Takes over the PC.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "press",
    description:
      'Press keys together, like "ctrl+s", "alt+tab", "enter", "f5", "win+d". Takes over the PC.',
    inputSchema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
  },
  {
    name: "record_start",
    description:
      "Start recording the screen (or one window, by title) to an MP4 in Videos\\Crew, with the mouse pointer. Stop with record_stop. Edit the result with ffmpeg in the shell.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "string" },
        name: { type: "string", description: "Short file name, no extension" },
        fps: { type: "number", description: "Frames per second, default 30" },
      },
    },
  },
  {
    name: "record_stop",
    description: "Stop the recording and get its file path, length and size.",
    inputSchema: { type: "object", properties: {} },
  },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

async function callTool(name, args) {
  switch (name) {
    case "screenshot": {
      let [left, top, width, height] = (await win("screen")).bounds;
      let what = "the screen";
      if (args.window) {
        const w = findWindow(parseWindows((await win("windows")).rows), args.window);
        if (w.minimized) return text(`"${w.title}" is minimized: focus_window first.`, true);
        [left, top, width, height] = (await win("rect", { hwnd: w.hwnd })).rect;
        what = `"${w.title}"`;
      }
      mkdirSync(SHOTS, { recursive: true });
      const path = join(SHOTS, `shot-${Date.now()}.jpg`);
      const { scale } = await win("capture", {
        left,
        top,
        width,
        height,
        maxWidth: SHOT_WIDTH,
        path,
      });
      lastShot = {
        left,
        top,
        scale,
        width: Math.round(width * scale),
        height: Math.round(height * scale),
      };
      return {
        content: [
          { type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/jpeg" },
          {
            type: "text",
            text: `Screenshot of ${what}, ${lastShot.width}×${lastShot.height}, saved at ${path}. Use x,y on this image.`,
          },
        ],
      };
    }
    case "list_windows": {
      const rows = parseWindows((await win("windows")).rows);
      return text(
        rows
          .map((w) => `${w.minimized ? "(minimized) " : ""}${w.title} — ${w.process}`)
          .join("\n") || "No open windows.",
      );
    }
    case "focus_window": {
      const w = findWindow(parseWindows((await win("windows")).rows), args.window);
      await ensureControl(`bring "${w.title}" to the front`);
      const { focused } = await win("focus", { hwnd: w.hwnd });
      await settle();
      return text(
        focused ? `"${w.title}" is in front.` : `Couldn't bring "${w.title}" to the front.`,
        !focused,
      );
    }
    case "click": {
      const at = toScreen(args, lastShot);
      await ensureControl(`click at ${args.x},${args.y}`);
      await win("click", { ...at, button: args.button ?? "left", count: args.double ? 2 : 1 });
      await settle();
      return text("Clicked. Take a screenshot to see what changed.");
    }
    case "move": {
      const at = toScreen(args, lastShot);
      await ensureControl("move the mouse");
      await win("move", at);
      await settle();
      return text("Moved.");
    }
    case "drag": {
      const from = toScreen(args, lastShot);
      const to = toScreen({ x: args.to_x, y: args.to_y }, lastShot);
      await ensureControl("drag");
      await win("drag", { x: from.x, y: from.y, x2: to.x, y2: to.y });
      await settle();
      return text("Dragged.");
    }
    case "scroll": {
      const at = toScreen(args, lastShot);
      await ensureControl("scroll");
      await win("scroll", { ...at, notches: Math.round(Number(args.amount) || 0) });
      await settle();
      return text("Scrolled.");
    }
    case "type": {
      const value = String(args.text ?? "");
      await ensureControl("type");
      await win("type", { text64: Buffer.from(value, "utf8").toString("base64") });
      await settle();
      return text(`Typed ${value.length} characters.`);
    }
    case "press": {
      const keys = parseKeys(args.keys);
      await ensureControl(`press ${args.keys}`);
      await win("chord", keys);
      await settle();
      return text(`Pressed ${args.keys}.`);
    }
    case "record_start": {
      if (recording) return text(`Already recording to ${recording.path}.`, true);
      if (!recordOk) {
        await consent("record your screen");
        recordOk = true;
      }
      mkdirSync(VIDEOS, { recursive: true });
      const d = new Date();
      const two = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
      const base = String(args.name ?? "recording")
        .replace(/[^\w.-]+/g, "-")
        .slice(0, 60);
      const path = join(VIDEOS, `${stamp}-${base}.mp4`);
      // gdigrab wants the exact title.
      const title = args.window
        ? findWindow(parseWindows((await win("windows")).rows), args.window).title
        : undefined;
      const proc = spawn("ffmpeg", recordArgs({ output: path, fps: args.fps, window: title }), {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      const r = { proc, path, startedAt: Date.now(), errors: "", timer: null };
      proc.stderr.on("data", (d) => (r.errors += d));
      proc.on("error", (err) => (r.errors += err.message));
      r.timer = setTimeout(() => stopRecording().catch(() => {}), MAX_RECORDING_MS);
      recording = r;
      await banner(recordingLine());
      await sleep(800);
      if (proc.exitCode !== null) {
        recording = null;
        await banner(null);
        return text(`ffmpeg stopped at once: ${r.errors.slice(-300) || "no output"}`, true);
      }
      return text(
        `Recording to ${path}. Call record_stop when done (it stops by itself after 15 minutes).`,
      );
    }
    case "record_stop": {
      const done = await stopRecording();
      return text(`Saved ${done.path} (${done.seconds} s, ${done.mb} MB).`);
    }
    default:
      return text(`unknown tool ${name}`, true);
  }
}

// --- MCP plumbing

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

createInterface({ input: process.stdin })
  .on("line", async (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (req.method === "initialize") {
      send({
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "desktop", version: "0.1.0" },
        },
      });
    } else if (req.method === "tools/list") {
      send({ id: req.id, result: { tools: TOOLS } });
    } else if (req.method === "tools/call") {
      let result;
      try {
        result = await callTool(req.params?.name, req.params?.arguments ?? {});
      } catch (err) {
        result = text(err instanceof Stop ? err.message : `Failed: ${err?.message ?? err}`, true);
      }
      send({ id: req.id, result });
    } else if (req.id !== undefined) {
      send({ id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
    }
  })
  .on("close", async () => {
    if (recording) await stopRecording().catch(() => {});
    host?.ps.kill();
    process.exit(0);
  });
