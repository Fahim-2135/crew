// Opening a file an agent linked, on the PC (its own app, or Explorer), and reading one for
// the phone. The rules are in core/files.mjs.

import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { checkPath, openAction, previewable, PREVIEW_BYTES } from "../core/files.mjs";

/**
 * Open a web link in the user's default browser (Chrome), not in the Edge window Crew runs in.
 * Only http and https; the URL is re-serialized, so it holds no quotes.
 * @param {string} input
 * @param {{ spawnFn?: typeof spawn }} [options]
 */
export function openUrl(input, options = {}) {
  let url;
  try {
    url = new URL(String(input ?? ""));
  } catch {
    throw new Error("not a web link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not a web link");
  if ((options.platform ?? process.platform) === "darwin") {
    (options.spawnFn ?? spawn)("open", [url.href], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, url: url.href };
  }
  (options.spawnFn ?? spawn)("explorer.exe", [`"${url.href}"`], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  }).unref();
  return { ok: true, url: url.href };
}

/** @param {string} path */
function statOf(path) {
  try {
    return statSync(path);
  } catch {
    throw new Error("no such file or folder");
  }
}

/**
 * Open a file in its app, a folder in Explorer, or show anything else selected in Explorer.
 * explorer.exe takes the path as one argument (no shell), so nothing in it runs as a command.
 * @param {string} input
 * @param {{ crewHome?: string, spawnFn?: typeof spawn }} [options]
 * @returns {{ ok: true, path: string, action: string }}
 */
export function openOnPc(input, options = {}) {
  const path = checkPath(input, options);
  const stat = statOf(path);
  const action = openAction(path, { isDirectory: stat.isDirectory() });
  if ((options.platform ?? process.platform) === "darwin") {
    // Finder: open the document or folder, or show anything else selected (-R).
    const args = action === "reveal" ? ["-R", path] : [path];
    (options.spawnFn ?? spawn)("open", args, { detached: true, stdio: "ignore" }).unref();
    return { ok: true, path, action };
  }
  // Quoted by hand: Explorer splits an unquoted argument at commas. Paths can't hold quotes.
  const arg = action === "reveal" ? `/select,"${path}"` : `"${path}"`;
  (options.spawnFn ?? spawn)("explorer.exe", [arg], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    windowsVerbatimArguments: true,
  }).unref();
  return { ok: true, path, action };
}

/**
 * A text file's contents for the phone (the first PREVIEW_BYTES of it).
 * @param {string} input
 * @param {{ crewHome?: string }} [options]
 * @returns {{ path: string, size: number, text: string, cut: boolean }}
 */
export function readPreview(input, options = {}) {
  const path = checkPath(input, options);
  const stat = statOf(path);
  if (stat.isDirectory()) throw new Error("that is a folder: open it on the PC");
  if (!previewable(path))
    throw new Error("the phone can't show this kind of file: open it on the PC");
  const length = Math.min(stat.size, PREVIEW_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  if (buffer.includes(0)) throw new Error("that isn't a text file: open it on the PC");
  return { path, size: stat.size, text: buffer.toString("utf8"), cut: stat.size > length };
}
