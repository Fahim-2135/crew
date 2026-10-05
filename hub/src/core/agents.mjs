// Reading the brain's agent definitions (`~/.claude/agents/brain/<name>.md`, installed by the
// brain's tools/install.mjs from system/agents/). The brain stays the single source of truth:
// Crew never keeps its own copy of an agent's prompt, it rebuilds the run definition from
// these files before every run.

import { owner, Owner, owners } from "./owner.mjs";

/** The team a new Crew starts with (config.team replaces it): a CEO who coordinates, and three
 * generalists. More are added from the window with New agent. */
export const STARTER_TEAM = Object.freeze([
  { id: "ceo", title: "CEO" },
  { id: "research", title: "Research" },
  { id: "writer", title: "Writer" },
  { id: "builder", title: "Builder" },
]);

/** Names a new agent may not take: system workers, and words the app and API use. (Names
 * already on the team are refused separately.) */
export const RESERVED = Object.freeze([
  "ceo",
  "archivist",
  "librarian",
  "mailroom",
  "crew",
  "system",
  "all",
  "you",
  "owner",
  "user",
  "hub",
  "phone",
]);

/** A new agent's id: lowercase letters and digits, 3–20 long (it names files and URLs). */
export const AGENT_ID = /^[a-z][a-z0-9]{2,19}$/;

/**
 * The agent file for a new department, in the same shape as the brain's own (system/agents/).
 * Like the rest of the team it has no tools line, so it gets the full toolset (coworker mode),
 * the same in Crew and in a terminal.
 * @param {{ id: string, title: string, description: string, instructions: string, web: boolean }} spec
 * @param {{ brainDir: string, guard?: boolean, name?: string }} where  name: what Claude Code
 *   calls the agent (the id with config.agentPrefix)  guard: the brain has tools/guard.mjs, which
 *   keeps each agent to its own folder inside the brain (and out of private/ and coder/)
 */
export function agentFileText(spec, where) {
  const brain = where.brainDir.replace(/\\/g, "/");
  const tick = "`";
  const memory = `${tick}${brain}/departments/${spec.id}/memory/${tick}`;
  return [
    "---",
    `name: ${where.name ?? spec.id}`,
    `description: ${spec.description.replace(/\s+/g, " ")}`,
    "model: sonnet",
    "memory: user",
    ...(where.guard
      ? [
          "hooks:",
          "  PreToolUse:",
          '    - matcher: "Read|Write|Edit|Glob|Grep|NotebookEdit"',
          "      hooks:",
          "        - type: command",
          `          command: node "${brain}/tools/guard.mjs" ${spec.id}`,
          "          timeout: 5",
        ]
      : []),
    "---",
    "",
    `You are **${spec.title}**, one of ${owners()} departments. ${Owner()} created you through Crew.`,
    "",
    spec.instructions.trim(),
    "",
    `**Your memory:** ${memory}. Its MEMORY.md index is already in your context; read the relevant notes before answering.`,
    "",
    `**When something durable is decided or learned,** write it as a note in your memory folder following ${tick}${brain}/AGENTS.md${tick}: one item per file named ${tick}${spec.id}--<slug>.md${tick}, front matter, absolute dates, supersede instead of duplicating. Work that belongs to another department goes to its inbox (${tick}departments/<name>/inbox/${tick}).`,
    "",
    `**Inside the brain** you write only in your own folder and other departments' inboxes${where.guard ? `, and never read ${tick}private/${tick} or ${tick}coder/${tick} (a hook enforces it)` : ""}. **Outside the brain** you can work anywhere on this PC: read files on any drive, run commands, edit projects. Anything that can't be undone or reaches other people (posting, sending, deleting, pushing to main) asks ${owner()} for a quick OK when you do it; just go ahead. Never write keys or credentials anywhere.`,
    "",
    `**Finish every task** with 2–5 lines: what you produced, what you filed to memory, any handoffs, and any decision ${owner()} must make, as options.`,
    "",
  ].join("\n");
}

/** The new department's write scope for the brain's guard (config/agents.json). */
export const scopeFor = (id) => ({
  write: [
    `departments/${id}/**`,
    "departments/*/inbox/**",
    "lessons/**",
    "people/**",
    "sources/**",
  ],
  outside: "write",
});

/**
 * Split a Markdown file with YAML front matter into its fields and body. Only the flat
 * `key: value` lines Crew needs are read; nested blocks (the `hooks:` section) are skipped,
 * because Crew supplies its own hooks.
 * @param {string} text
 * @returns {{ name: string, description: string, tools: string[], model: string | null,
 *   memory: string | null, body: string }}
 */
export function parseAgentFile(text) {
  const normalized = String(text).replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error("agent file has no front matter");

  const fields = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!fields.name) throw new Error("agent file has no name");

  return {
    name: fields.name,
    description: fields.description ?? "",
    tools: fields.tools
      ? fields.tools
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    model: fields.model || null,
    memory: fields.memory || null,
    body: match[2].trim(),
  };
}
