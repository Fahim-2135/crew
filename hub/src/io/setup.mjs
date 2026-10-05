// `crew setup`: a new brain from the kit, the starter team, and Crew's own settings. Everything
// here can run twice: what already exists is left alone.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "./team.mjs";
import { STARTER_AGENTS } from "../core/starter.mjs";
import { setOwner } from "../core/owner.mjs";

const KIT = fileURLToPath(new URL("../../brain-kit/", import.meta.url));

/** Copy the kit's files into a new brain, filling in the brief. */
function copyKit(brainDir, fill) {
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const src = join(from, entry.name);
      const name = entry.name === "gitignore.txt" ? ".gitignore" : entry.name;
      const dest = join(to, name);
      if (entry.isDirectory()) walk(src, dest);
      else if (!existsSync(dest)) {
        if (name.endsWith(".md")) writeFileSync(dest, fill(readFileSync(src, "utf8")));
        else copyFileSync(src, dest);
      }
    }
  };
  walk(KIT, brainDir);
}

/**
 * @param {{ brainDir: string, agentsDir: string, owner: string, focus: string, today: string,
 *   prefix?: string }} o
 * @returns {{ created: string[], kept: string[], git: boolean }}
 */
export function createBrain(o) {
  setOwner(o.owner);
  const fill = (text) =>
    text
      .replaceAll("{{owner}}", o.owner || "the user")
      .replaceAll("{{today}}", o.today)
      .replaceAll(
        "{{focus}}",
        o.focus?.trim()
          ? `What they are working on: ${o.focus.trim()}`
          : "What they are working on: (the CEO adds this once it is clear)",
      );
  copyKit(o.brainDir, fill);
  for (const dir of ["lessons", join("system", "agents")])
    mkdirSync(join(o.brainDir, dir), { recursive: true });

  const created = [];
  const kept = [];
  for (const agent of STARTER_AGENTS) {
    const out = createAgent(agent, {
      brainDir: o.brainDir,
      agentsDir: o.agentsDir,
      prefix: o.prefix ?? "crew-",
      today: o.today,
    });
    (out.status === "executed" ? created : kept).push(agent.id);
    if (out.status === "failed") throw new Error(out.result);
  }

  // Git keeps every change the agents make; Crew commits after each run.
  let git = existsSync(join(o.brainDir, ".git"));
  if (!git) {
    const run = (...args) =>
      spawnSync("git", args, { cwd: o.brainDir, windowsHide: true, encoding: "utf8" });
    if (run("init", "-q").status === 0) {
      run("add", "-A");
      run(
        "-c",
        "user.name=Crew",
        "-c",
        "user.email=crew@localhost",
        "commit",
        "-q",
        "-m",
        "brain: the start",
      );
      git = true;
    }
  }
  return { created, kept, git };
}

/** Crew's settings file: who the team works for, and where the brain is. */
export function writeSettings(home, settings) {
  const file = join(home, "config.json");
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...current, ...settings }, null, 2) + "\n");
  return file;
}
