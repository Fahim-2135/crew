// Rules for an agent using the user's own desktop (mcp-desktop.mjs): key names, mapping a click
// on a screenshot back to the screen, and when the agent may take over the mouse and keyboard.
// Pure.

/** They have been away this long: an agent may take over without asking. */
export const AWAY_MS = 5 * 60_000;
/** The banner counts down this long before the first input, so they can stop it. */
export const COUNTDOWN_S = 5;
/** The cursor moving this far from where the agent left it means the user took it back. */
export const MOVE_TOLERANCE_PX = 4;
/** Screenshots are shrunk to this width (enough to read, cheap to send). */
export const SHOT_WIDTH = 1366;

const NAMED = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  win: 0x5b,
  windows: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
  printscreen: 0x2c,
  capslock: 0x14,
  menu: 0x5d,
  plus: 0xbb,
  minus: 0xbd,
  ";": 0xba,
  "=": 0xbb,
  ",": 0xbc,
  "-": 0xbd,
  ".": 0xbe,
  "/": 0xbf,
  "`": 0xc0,
  "[": 0xdb,
  "\\": 0xdc,
  "]": 0xdd,
  "'": 0xde,
};
/** Keys Windows wants flagged as extended, or they arrive as their numpad twins. */
const EXTENDED = new Set([0x2e, 0x2d, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5b, 0x5d]);

/**
 * "ctrl+shift+s", "alt+tab", "enter", "f5" → virtual-key codes, pressed in order.
 * @param {string} combo
 * @returns {{ vks: number[], ext: boolean[] }}
 */
export function parseKeys(combo) {
  const parts = String(combo ?? "")
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("no keys given");
  const vks = parts.map((p) => {
    if (p in NAMED) return NAMED[p];
    if (/^[a-z0-9]$/.test(p)) return p.toUpperCase().charCodeAt(0);
    const f = /^f([1-9]|1[0-2])$/.exec(p);
    if (f) return 0x6f + Number(f[1]);
    throw new Error(`unknown key "${p}"`);
  });
  return { vks, ext: vks.map((vk) => EXTENDED.has(vk)) };
}

/**
 * A point on the last screenshot → a point on the screen.
 * @param {{ x: number, y: number }} point
 * @param {{ left: number, top: number, scale: number, width: number, height: number }} shot
 */
export function toScreen(point, shot) {
  if (!shot) throw new Error("take a screenshot first: coordinates are read from it");
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be numbers");
  if (x < 0 || y < 0 || x > shot.width || y > shot.height) {
    throw new Error(`(${x}, ${y}) is outside the last screenshot (${shot.width}×${shot.height})`);
  }
  return {
    x: Math.round(shot.left + x / shot.scale),
    y: Math.round(shot.top + y / shot.scale),
  };
}

/**
 * May an agent start using the mouse and keyboard now?
 * In a Crew run: straight away if the user has been away a while, else only with their quick OK.
 * In a terminal session they are there, and Claude Code's own permission prompt is the OK.
 * @param {{ inCrew: boolean, idleMs: number }} context
 * @returns {"go" | "ask"}
 */
export function takeover({ inCrew, idleMs }) {
  if (!inCrew) return "go";
  return idleMs >= AWAY_MS ? "go" : "ask";
}

/** Did the cursor move away from where the agent left it? */
export function tookBack(left, now) {
  if (!left || !now) return false;
  return Math.hypot(now[0] - left[0], now[1] - left[1]) > MOVE_TOLERANCE_PX;
}

/** Rows from the host's window list. */
export function parseWindows(rows) {
  return rows.map((row) => {
    const [hwnd, process, left, top, width, height, minimized, ...title] = row.split("|");
    return {
      hwnd: Number(hwnd),
      process,
      title: title.join("|"),
      left: Number(left),
      top: Number(top),
      width: Number(width),
      height: Number(height),
      minimized: minimized === "1",
    };
  });
}

/** The window whose title (or process name) best matches what the agent asked for. */
export function findWindow(windows, query) {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!q) throw new Error("say which window");
  const exact = windows.find((w) => w.title.toLowerCase() === q);
  if (exact) return exact;
  const hit =
    windows.find((w) => w.title.toLowerCase().includes(q)) ??
    windows.find((w) => w.process.toLowerCase() === q);
  if (!hit) throw new Error(`no open window matches "${query}"`);
  return hit;
}

/**
 * ffmpeg arguments for recording the screen or one window (gdigrab), to an H.264 MP4.
 * @param {{ output: string, fps?: number, window?: string, region?: number[] }} spec
 */
export function recordArgs(spec) {
  const fps = Math.min(60, Math.max(5, Math.round(spec.fps ?? 30)));
  const input = ["-f", "gdigrab", "-framerate", String(fps), "-draw_mouse", "1"];
  if (spec.region) {
    const [x, y, w, h] = spec.region.map((n) => Math.round(n));
    // H.264 wants even sizes.
    input.push(
      "-offset_x",
      String(x),
      "-offset_y",
      String(y),
      "-video_size",
      `${w - (w % 2)}x${h - (h % 2)}`,
    );
  }
  input.push("-i", spec.window ? `title=${spec.window}` : "desktop");
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...input,
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    spec.output,
  ];
}
