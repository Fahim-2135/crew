// Computer use on the user's own desktop: the rules the desktop tool follows.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AWAY_MS,
  findWindow,
  parseKeys,
  parseWindows,
  recordArgs,
  takeover,
  toScreen,
  tookBack,
} from "../src/core/desktop.mjs";
import { gateFor } from "../src/core/gate.mjs";

test("taking over: straight away only when he is away; a terminal session is his own OK", () => {
  assert.equal(takeover({ inCrew: true, idleMs: 30_000 }), "ask");
  assert.equal(takeover({ inCrew: true, idleMs: AWAY_MS }), "go");
  assert.equal(takeover({ inCrew: false, idleMs: 0 }), "go");
  assert.equal(tookBack([100, 100], [102, 101]), false, "a jitter is not him");
  assert.equal(tookBack([100, 100], [140, 100]), true);
  assert.equal(tookBack(null, [1, 1]), false);
});

test("clicks are read from the last screenshot and land on the real screen", () => {
  const shot = { left: 0, top: 0, scale: 1366 / 1920, width: 1366, height: 768 };
  assert.deepEqual(toScreen({ x: 683, y: 384 }, shot), { x: 960, y: 540 });
  const window = { left: 1714, top: 199, scale: 1, width: 177, height: 177 };
  assert.deepEqual(toScreen({ x: 10, y: 20 }, window), { x: 1724, y: 219 });
  assert.throws(() => toScreen({ x: 1, y: 1 }, null), /screenshot first/);
  assert.throws(() => toScreen({ x: 2000, y: 1 }, shot), /outside/);
  assert.throws(() => toScreen({ x: "a", y: 1 }, shot), /numbers/);
});

test("key chords", () => {
  assert.deepEqual(parseKeys("ctrl+shift+s"), {
    vks: [0x11, 0x10, 0x53],
    ext: [false, false, false],
  });
  assert.deepEqual(parseKeys("Enter").vks, [0x0d]);
  assert.deepEqual(parseKeys("alt+f4").vks, [0x12, 0x73]);
  assert.deepEqual(parseKeys("win+d"), { vks: [0x5b, 0x44], ext: [true, false] });
  assert.equal(parseKeys("ctrl+right").ext[1], true, "arrows are extended keys");
  assert.throws(() => parseKeys("ctrl+banana"), /unknown key "banana"/);
  assert.throws(() => parseKeys(""), /no keys/);
});

test("windows are found by title, then by app", () => {
  const windows = parseWindows([
    "1|claude-face|1714|199|177|177|0|claude-face",
    "2|Code|-9|-9|1938|1038|0|Claude mods - crazy - Visual Studio Code",
    "3|chrome|-32000|-32000|199|34|1|Play Console | My App - Google Chrome",
  ]);
  assert.equal(windows[2].title, "Play Console | My App - Google Chrome", "titles may hold |");
  assert.equal(windows[2].minimized, true);
  assert.equal(findWindow(windows, "visual studio").hwnd, 2);
  assert.equal(findWindow(windows, "CLAUDE-FACE").hwnd, 1);
  assert.equal(findWindow(windows, "chrome").hwnd, 3);
  assert.throws(() => findWindow(windows, "photoshop"), /no open window/);
});

test("recording: the screen or one window, as an MP4 that plays everywhere", () => {
  const screen = recordArgs({ output: "C:/v/a.mp4" });
  assert.deepEqual(screen.slice(screen.indexOf("-i"), screen.indexOf("-i") + 2), ["-i", "desktop"]);
  assert.equal(screen.at(-1), "C:/v/a.mp4");
  assert.ok(screen.includes("yuv420p") && screen.includes("libx264"));
  const one = recordArgs({ output: "x.mp4", window: "claude-face", fps: 500 });
  assert.ok(one.includes("title=claude-face"));
  assert.equal(one[one.indexOf("-framerate") + 1], "60", "capped");
  const region = recordArgs({ output: "x.mp4", region: [10, 20, 301, 201] });
  assert.equal(region[region.indexOf("-video_size") + 1], "300x200", "even sizes");
});

test("from an email, even a screenshot waits for his OK", () => {
  assert.equal(gateFor({ tool: "mcp__desktop__screenshot", input: {}, tainted: true }).ask, true);
  assert.equal(gateFor({ tool: "mcp__desktop__screenshot", input: {} }).ask, false);
});
