// Watching the department inboxes. fs.watch reacts within a second or two; a rescan every
// five minutes catches anything it misses (fs.watch drops events on Windows now and then).

import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { inboxItem } from "../core/inbox.mjs";

/**
 * Every inbox item in the given departments.
 * @param {string} brainDir
 * @param {string[]} departments
 */
export function scanInboxes(brainDir, departments) {
  const items = [];
  for (const dept of departments) {
    const dir = join(brainDir, "departments", dept, "inbox");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const rel = `departments/${dept}/inbox/${file}`;
      let text;
      try {
        text = readFileSync(join(dir, file), "utf8");
      } catch {
        continue; // removed or locked mid-scan; the next scan sees it
      }
      const item = inboxItem(rel, text);
      if (item) items.push(item);
    }
  }
  return items;
}

/**
 * Call `onChange` (debounced) whenever something under departments/ changes, and every
 * `rescanMs` regardless.
 * @returns {() => void} stop watching
 */
export function watchInboxes(brainDir, onChange, rescanMs = 5 * 60_000) {
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 2000);
  };
  let watcher = null;
  try {
    watcher = watch(join(brainDir, "departments"), { recursive: true }, (_event, name) => {
      if (name && /[\\/]inbox[\\/]/.test(String(name))) fire();
    });
    watcher.on("error", () => {
      /* the rescan below still runs */
    });
  } catch {
    watcher = null;
  }
  const interval = setInterval(onChange, rescanMs);
  interval.unref?.();
  return () => {
    clearTimeout(timer);
    clearInterval(interval);
    watcher?.close();
  };
}
