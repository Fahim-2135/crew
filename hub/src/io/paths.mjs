// Where Crew keeps its state, and the files it hands to each Claude Code run.
//
// State lives outside the brain, in %LOCALAPPDATA%\crew (override with CREW_HOME): the
// database, the local access token, logs, and the per-run definition files. The brain only
// ever receives what the agents themselves write.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

/** @param {NodeJS.ProcessEnv} [env] */
export function crewPaths(env = process.env) {
  const home =
    env.CREW_HOME || join(env.LOCALAPPDATA || join(homedir(), ".local", "share"), "crew");
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return {
    home,
    db: join(home, "crew.db"),
    token: join(home, "local-token"),
    logs: join(home, "logs"),
    runs: join(home, "runs"),
    // The brain (shared memory) and the agents' definitions; config.brain and config.agentsDir
    // override these (applyConfig).
    brain: (env.CREW_BRAIN || join(homedir(), "crew-brain")).replace(/\\/g, "/"),
    agentsDir: join(claudeDir, "agents", "crew"),
    crewGuard: fileURLToPath(new URL("../hooks/crew-guard.mjs", import.meta.url)).replace(
      /\\/g,
      "/",
    ),
    mcpServer: fileURLToPath(new URL("./mcp-crew.mjs", import.meta.url)).replace(/\\/g, "/"),
    // The `crew` command itself, so other tools (claude-face) can open the window on an agent.
    cli: fileURLToPath(new URL("../../bin/crew.mjs", import.meta.url)).replace(/\\/g, "/"),
    gateHook: fileURLToPath(new URL("./gate-hook.mjs", import.meta.url)).replace(/\\/g, "/"),
    port: Number(env.CREW_PORT || 7788),
    // Files the user attaches to messages: outside Crew's own state, so agents and links can open them.
    attachments: env.CREW_ATTACHMENTS || join(homedir(), "Documents", "Crew", "attachments"),
  };
}

/** Settings in config.json that move the brain or the agents' folder. */
export function applyConfig(paths, config) {
  if (config.brain) paths.brain = String(config.brain).replace(/\\/g, "/");
  if (config.agentsDir) paths.agentsDir = String(config.agentsDir);
  return paths;
}

/** Create the state folders. */
export function ensureDirs(paths) {
  for (const dir of [paths.home, paths.logs, paths.runs]) mkdirSync(dir, { recursive: true });
}

/**
 * The token the CLI and the mod use on this machine. Created on first start; 256 random bits.
 * @returns {string}
 */
export function localToken(paths) {
  if (existsSync(paths.token)) return readFileSync(paths.token, "utf8").trim();
  const token = randomBytes(32).toString("hex");
  writeFileSync(paths.token, token + "\n", { mode: 0o600 });
  return token;
}
