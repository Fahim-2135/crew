// Creating a new department agent once the user approves it (approval type `agent.create`). It
// is laid out like the brain's own departments, so the agent works in Crew and in any Claude
// Code session:
//   brain/system/agents/<id>.md         the definition (the brain's source of truth)
//   ~/.claude/agents/brain/<id>.md      the installed copy Claude Code reads
//   brain/departments/<id>/             README, memory/MEMORY.md, inbox/, outputs/
//   brain/config/agents.json            its write scope, enforced by the brain's guard
//   ~/.claude/agent-memory/<id>         a junction to its brain memory, like the others

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { agentFileText, scopeFor } from "../core/agents.mjs";
import { owners } from "../core/owner.mjs";

/**
 * @param {{ id: string, title: string, description: string, instructions: string, web: string }} payload
 * @param {{ brainDir: string, agentsDir: string, today: string, prefix?: string }} where
 * @returns {{ status: "executed" | "stale" | "failed", result: string }}
 */
export function createAgent(payload, where) {
  const { id } = payload;
  const name = `${where.prefix ?? ""}${id}`; // what Claude Code calls it
  const installed = join(where.agentsDir, `${name}.md`);
  const source = join(where.brainDir, "system", "agents", `${name}.md`);
  const dept = join(where.brainDir, "departments", id);
  if ([installed, source, dept].some(existsSync)) {
    return { status: "stale", result: `an agent or department named ${id} already exists` };
  }
  try {
    const spec = { ...payload, web: payload.web === "yes" };
    const guard = existsSync(join(where.brainDir, "tools", "guard.mjs"));
    const text = agentFileText(spec, { brainDir: where.brainDir, guard, name });
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, text);
    mkdirSync(where.agentsDir, { recursive: true });
    writeFileSync(installed, text);

    for (const sub of ["memory", "inbox", "outputs"])
      mkdirSync(join(dept, sub), { recursive: true });
    writeFileSync(
      join(dept, "README.md"),
      `# ${payload.title}\n\n${payload.description}\n\nCreated through Crew on ${where.today}, at ${owners()} request.\n`,
    );
    writeFileSync(
      join(dept, "memory", "MEMORY.md"),
      `# ${payload.title} memory\n\nOne line per note; the notes live next to this file.\n`,
    );
    for (const sub of ["inbox", "outputs"]) writeFileSync(join(dept, sub, ".gitkeep"), "");

    addScope(join(where.brainDir, "config", "agents.json"), id);

    // Claude Code's own memory folder for this agent is its brain memory, as for the others.
    const link = join(dirname(dirname(where.agentsDir)), "agent-memory", name);
    if (!existsSync(link)) {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(dept, "memory"), link, "junction");
    }
    return {
      status: "executed",
      result: `${payload.title} (${id}) is on the team: definition, department folder, write scope and memory are in place.`,
      files: [
        source,
        join(dept, "README.md"),
        join(dept, "memory", "MEMORY.md"),
        join(dept, "inbox", ".gitkeep"),
        join(dept, "outputs", ".gitkeep"),
        join(where.brainDir, "config", "agents.json"),
      ],
    };
  } catch (err) {
    return { status: "failed", result: `could not create ${id}: ${err?.message ?? err}` };
  }
}

/**
 * Add the agent's scope to the brain guard's config, keeping the file's hand-aligned layout:
 * the new entry goes in as one line after the last agent.
 */
function addScope(file, id) {
  const text = readFileSync(file, "utf8");
  const config = JSON.parse(text);
  if (config.agents?.[id]) return;
  const line = `    ${JSON.stringify(id)}: ${JSON.stringify(scopeFor(id)).replace(/,"/g, ', "').replace(/":/g, '": ')}`;
  const end = text.lastIndexOf("\n  }");
  let next = end > 0 ? `${text.slice(0, end)},\n${line}${text.slice(end)}` : null;
  try {
    if (!next || !JSON.parse(next).agents?.[id]) throw new Error("layout");
  } catch {
    config.agents = { ...config.agents, [id]: scopeFor(id) };
    next = `${JSON.stringify(config, null, 2)}\n`;
  }
  writeFileSync(file, next);
}

/** A fingerprint of an agent's installed definition, recorded when an update is requested. */
export function definitionHash(agentsDir, id) {
  const file = join(agentsDir, `${id}.md`);
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
}

/**
 * Replace an agent's standing instructions (approval type `agent.update`): the front matter
 * (name, tools, model, guard hook) stays exactly as it was, so an agent can never widen its
 * own tools or scope this way. The old file is kept in brain/system/agents/history/.
 * @param {{ id: string, instructions: string, change: string }} payload
 * @param {{ brainDir: string, agentsDir: string, today: string, expectHash: string | null,
 *   prefix?: string }} where
 * @returns {{ status: "executed" | "stale" | "failed", result: string }}
 */
export function updateAgent(payload, where) {
  const { id } = payload;
  const name = `${where.prefix ?? ""}${id}`;
  const installed = join(where.agentsDir, `${name}.md`);
  if (!existsSync(installed)) return { status: "failed", result: `no agent file for ${id}` };
  if (where.expectHash && definitionHash(where.agentsDir, name) !== where.expectHash) {
    return { status: "stale", result: `${id}'s definition changed since the request` };
  }
  try {
    const old = readFileSync(installed, "utf8").replace(/\r\n/g, "\n");
    const match = /^(---\n[\s\S]*?\n---\n)/.exec(old);
    if (!match) return { status: "failed", result: `${id}'s file has no front matter` };
    const next = `${match[1]}\n${payload.instructions.trim()}\n`;

    const history = join(where.brainDir, "system", "agents", "history");
    mkdirSync(history, { recursive: true });
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
    const backup = join(history, `${id}-${where.today}-${stamp}.md`);
    writeFileSync(backup, old);

    writeFileSync(installed, next);
    const source = join(where.brainDir, "system", "agents", `${name}.md`);
    writeFileSync(source, next);
    return {
      status: "executed",
      result: `${id}'s instructions are updated (the old version is in system/agents/history/).`,
      files: [source, backup],
    };
  } catch (err) {
    return { status: "failed", result: `could not update ${id}: ${err?.message ?? err}` };
  }
}
