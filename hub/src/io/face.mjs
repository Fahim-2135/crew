// claude-face, the floating face that shows what Claude Code is doing, switched on and off from
// the Crew window. On: it starts now and with Windows. Off: it closes and stays closed. It keeps
// reacting to every Claude Code session on the PC, Crew's agents included.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "electron.app.claude-face"; // the name claude-face itself uses for its autostart
const PORT = 7777;

export function faceExe(env = process.env) {
  return join(env.LOCALAPPDATA ?? "", "Programs", "claude-face", "claude-face.exe");
}

async function running() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/state`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function autostart() {
  const out = spawnSync("reg", ["query", RUN_KEY, "/v", RUN_VALUE], {
    encoding: "utf8",
    windowsHide: true,
  });
  return out.status === 0;
}

/** @returns {Promise<{ installed: boolean, on: boolean, running: boolean, autostart: boolean }>} */
export async function faceStatus() {
  const installed = process.platform === "win32" && existsSync(faceExe());
  if (!installed) return { installed, on: false, running: false, autostart: false };
  const [isRunning, isAuto] = [await running(), autostart()];
  return { installed, on: isRunning, running: isRunning, autostart: isAuto };
}

const RELEASES = "https://api.github.com/repos/Fahim-2135/claude-face/releases/latest";

/**
 * Install claude-face from its latest GitHub release and start it showing only Crew's agents,
 * connected to Claude Code (the user said yes in Crew's setup). Windows only for now.
 * @returns {Promise<{ version: string }>}
 */
export async function installFace({ crewOnly = true } = {}) {
  if (process.platform !== "win32") throw new Error("claude-face is Windows-only for now");
  const release = await (await fetch(RELEASES, { headers: { "user-agent": "crew" } })).json();
  const asset = (release.assets ?? []).find((a) => /\.exe$/i.test(a.name));
  if (!asset) throw new Error("no installer in claude-face's latest release");
  const file = join(process.env.TEMP ?? ".", asset.name.replace(/\s+/g, "-"));
  const res = await fetch(asset.browser_download_url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const out = spawnSync(file, ["/S"], { windowsHide: true, timeout: 120_000 });
  if (out.status !== 0) throw new Error(`the installer failed (exit ${out.status})`);
  spawnSync("taskkill", ["/IM", "claude-face.exe", "/F"], { windowsHide: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const flags = ["--connect", ...(crewOnly ? ["--crew-only"] : [])];
  spawn(faceExe(), flags, { detached: true, stdio: "ignore", env }).unref();
  for (let i = 0; i < 40 && !(await running()); i++) await new Promise((r) => setTimeout(r, 250));
  return { version: String(release.tag_name ?? "") };
}

/** Switch it on (start now and with Windows) or off (close it, and not with Windows). */
export async function setFace(on) {
  const exe = faceExe();
  if (process.platform !== "win32" || !existsSync(exe))
    throw new Error("claude-face isn't installed");
  if (on) {
    spawnSync("reg", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `"${exe}"`, "/f"], {
      windowsHide: true,
    });
    if (!(await running())) {
      // Without ELECTRON_RUN_AS_NODE: VS Code sets it for its extensions, and a hub started from
      // there passes it on, which makes an Electron app run as plain Node and quit at once.
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false, env }).unref();
      for (let i = 0; i < 20 && !(await running()); i++)
        await new Promise((r) => setTimeout(r, 250));
    }
  } else {
    spawnSync("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], { windowsHide: true });
    spawnSync("taskkill", ["/IM", "claude-face.exe", "/F"], { windowsHide: true });
  }
  return faceStatus();
}
