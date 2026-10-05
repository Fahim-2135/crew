// Reading a Claude Code session's transcript (~/.claude/projects/<folder>/<session>.jsonl),
// so turns the user had with an agent in a terminal show up in Crew as well.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

/**
 * @param {string} sessionId
 * @returns {{ entries: Array<Record<string, any>>, mtimeMs: number } | null}
 */
export function readTranscript(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId))) return null;
  let file = null;
  try {
    for (const dir of readdirSync(PROJECTS)) {
      const candidate = join(PROJECTS, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        file = candidate;
        break;
      }
    }
  } catch {
    return null;
  }
  if (!file) return null;
  const entries = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* a line still being written */
    }
  }
  return { entries, mtimeMs: statSync(file).mtimeMs };
}
