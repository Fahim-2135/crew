#!/usr/bin/env node
// PreToolUse hook for every Crew run: a write may only land inside the brain.
//
//   node crew-guard.mjs <brainDir>      (stdin: the PreToolUse payload)
//
// The brain's own guard (tools/guard.mjs) enforces each department's scope, but it lets the
// CEO, engineering and coder write anywhere. In Crew, agents read and draft only, so this
// guard denies every write outside the brain, for every agent. Paths are resolved through
// junctions (agent memory folders are junctions into the brain) before they are compared.
//
// Prints a deny decision, or nothing to let the normal flow continue. It never calls
// process.exit() after writing: on Windows a piped stdout can be cut off before it flushes.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { owner } from "../core/owner.mjs";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Resolve the longest existing ancestor through junctions and symlinks, then re-append. */
export function realPath(p) {
  let current = resolve(p);
  const rest = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  let resolved = current;
  try {
    resolved = realpathSync.native(current);
  } catch {
    /* keep it as is */
  }
  return join(resolved, ...rest);
}

const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * @param {{ tool_name?: string, tool_input?: Record<string, unknown>, cwd?: string }} payload
 * @param {string} brainDir
 * @returns {string | null} the reason to deny, or null to allow
 */
export function denyReason(payload, brainDir) {
  if (!WRITE_TOOLS.has(String(payload.tool_name ?? ""))) return null;
  const input = payload.tool_input ?? {};
  const target = input.file_path ?? input.notebook_path;
  if (!target) return null;
  const absolute = realPath(resolve(String(payload.cwd ?? brainDir), String(target)));
  const root = norm(realPath(brainDir));
  const path = norm(absolute);
  if (path === root || path.startsWith(root + "/")) return null;
  return `[crew guard] Crew agents write only inside the brain; ${String(target)} is outside it. Draft it in your department's outputs/ folder and ask ${owner()}.`;
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const brainDir = process.argv[2];
  let payload;
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    payload = {}; // an unreadable payload names no file, so nothing is denied
  }
  const reason = brainDir ? denyReason(payload, brainDir) : "[crew guard] no brain directory given";
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  }
}
