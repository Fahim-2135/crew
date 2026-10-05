// Where Crew runs from once it is set up: a copy in Crew's own folder (~/AppData/Local/crew/app,
// ~/.local/share/crew/app on a Mac). A plugin lives in a versioned folder that changes with
// every update, and autostart and the desktop shortcut need a path that stays put. Crew has no
// dependencies, so the copy is just its files.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder holding package.json, hub/ and shared/ for the code that is running now. */
export const sourceRoot = () => resolve(fileURLToPath(new URL("../../../", import.meta.url)));

const PARTS = ["package.json", "hub/bin", "hub/src", "hub/web", "hub/brain-kit", "shared"];

/**
 * Copy Crew to `<home>/app` (replacing an older copy) unless it is already running from there.
 * @returns {{ cli: string, copied: boolean }} the crew.mjs to use from now on
 */
export function installApp(home, from = sourceRoot()) {
  const app = join(home, "app");
  const cli = join(app, "hub", "bin", "crew.mjs");
  if (resolve(from).toLowerCase() === resolve(app).toLowerCase()) return { cli, copied: false };
  for (const part of PARTS) {
    const src = join(from, part);
    if (!existsSync(src)) throw new Error(`Crew's files are incomplete: ${part} is missing`);
    const dest = join(app, part);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(dest, ".."), { recursive: true });
    cpSync(src, dest, {
      recursive: true,
      filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p),
    });
  }
  return { cli, copied: true };
}
