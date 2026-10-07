// Skills that agents write and keep improving on their own (Praxis with a threshold of one).
//
// The loop, for every agent:
//   1. After a task that took real work, Crew gives the agent one more short turn in the same
//      session (a "review"): it writes down how it did the task, as a *record*.
//   2. The next time a task like it comes in, the agent sees the record in its list, turns it
//      into a *skill* (version 1) and does the task by following it.
//   3. After every run that used a skill, the review updates it with what was learned: a new
//      version, the old one kept in history/, a line in CHANGELOG.md.
// Each agent owns `departments/<agent>/skills/<slug>/SKILL.md`; teammates may use each other's
// skills and send what they learned to the owner's inbox. Older playbooks
// (`departments/<agent>/playbooks/*.md`) count as records.

/** A task with at least this many tool calls is worth a review. */
export const REVIEW_MIN_TOOLS = 5;

/** Job kinds whose work is reviewed (not reviews themselves, nor learning or approvals). */
export const REVIEWED_KINDS = new Set(["chat", "call", "inbox", "schedule", "reply", "ask"]);

/** Whether a finished job gets a skill review. */
export function needsReview(job, toolCount) {
  return REVIEWED_KINDS.has(job.kind) && toolCount >= REVIEW_MIN_TOOLS;
}

/** A review reply that saved nothing: Crew leaves the chat alone. */
export function savedNothing(reply) {
  // "nothing to save", alone or with a short reason after it.
  return /^\W*nothing to save\b/i.test(String(reply).trim());
}

/**
 * The front matter of a SKILL.md or playbook (simple `key: value` lines between `---`).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text));
  if (!m) return {};
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return fields;
}

/**
 * One entry of the skills list, from a file's path and text.
 * @param {{ owner: string, path: string, text: string, playbook?: boolean }} file
 */
export function skillEntry({ owner, path, text, playbook = false }) {
  const f = frontMatter(text);
  const firstLine = String(text)
    .replace(/^---[\s\S]*?---/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  const name =
    f.name ||
    path
      .split("/")
      .slice(playbook ? -1 : -2)[0]
      .replace(/\.md$/, "");
  return {
    owner,
    path,
    name,
    // Brain links ([[note-id]]) read as plain words.
    description: (f.description || firstLine || "").replace(/\[\[([^\]]+)\]\]/g, "$1"),
    stage: playbook ? "record" : f.stage === "record" ? "record" : "skill",
    version: playbook ? 0 : Number(f.version) || (f.stage === "record" ? 0 : 1),
    playbook,
  };
}

const short = (text, max) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The part of the system prompt that lists the agent's skills and records, and its teammates'
 * skills, with how to use them.
 * @param {{ agent: string, brain: string, entries: ReturnType<typeof skillEntry>[] }} input
 */
export function skillsNote({ agent, brain, entries }) {
  const root = `${brain.replace(/\\/g, "/")}/departments/${agent}/skills`;
  const own = entries.filter((e) => e.owner === agent);
  const others = entries.filter((e) => e.owner !== agent && e.stage === "skill");
  const line = (e) =>
    `- ${e.name} (${e.stage === "skill" ? `skill v${e.version}` : e.playbook ? "playbook" : "record"}${
      e.owner === agent ? "" : `, ${e.owner}'s`
    }): ${short(e.description, 160)} — ${e.path}`;
  return [
    "# Your skills",
    "You keep skills for work you do more than once, and they get better every time you use them.",
    own.length
      ? ["Yours:", ...own.map(line)].join("\n")
      : "Yours: none yet. Your first one comes from the review after your next real task.",
    others.length ? ["Your teammates' (you may use them):", ...others.map(line)].join("\n") : "",
    [
      "Before you start a task, check this list. When the task is the kind of work one of them covers:",
      "- a **skill**: read its SKILL.md and do the task by following it. Start your reply with `Using skill: <name> (v<version>)`.",
      `- a **record** or **playbook** (you did it once before): this is the second time, so first turn it into a skill in ${root}/<slug>/SKILL.md (front matter name, description saying which requests it is for, stage: skill, version: 1; the full method below it), then follow it. Start your reply with \`Using skill: <name> (v1, new)\`.`,
      "- a teammate's skill: follow it the same way; don't edit their file.",
      "Skip all this for a quick answer or a one-off. After the task Crew asks you to update the skill with what you learned.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The prompt of the review turn that follows a task: write the record, or improve the skill.
 * @param {{ agent: string, brain: string, request: string, today: string, owner: string }} input
 */
export function reviewPrompt({ agent, brain, request, today, owner }) {
  const root = `${brain.replace(/\\/g, "/")}/departments/${agent}/skills`;
  return [
    `Crew skill review for the task you just finished: "${short(request, 300)}".`,
    "Write down what you learned so the next time is faster and better. Do exactly one of these:",
    `1. **You followed one of your skills.** Update it: copy the current SKILL.md to history/v<old version>.md in its folder, then rewrite SKILL.md with what this run taught you (new or better steps, exact commands, settings and paths, checks, mistakes and their fixes, anything ${owner} corrected or asked for), raise \`version\` by 1, set \`updated: ${today}\`, and add a line to CHANGELOG.md in the same folder: \`${today} v<new>: <what changed and why>\`.`,
    `2. **A record or playbook of yours covered it** but you didn't turn it into a skill yet: do that now (${root}/<slug>/SKILL.md, stage: skill, version: 1, with both runs' lessons), and start its CHANGELOG.md.`,
    `3. **You used a teammate's skill.** Don't edit it. Write what you learned to their inbox (departments/<their id>/inbox/<date>-${agent}-skill-<slug>.md, front matter from, to, created, status: open) so they update it.`,
    `4. **Nothing covered it** and it is work that could come again: write a record in ${root}/<slug>/SKILL.md with front matter \`name\`, \`description\` (which requests it is for, in words a future request would use), \`stage: record\`, \`version: 0\`, \`updated: ${today}\`; then the whole process as you actually did it: goal, inputs, every step with the exact tools, commands, settings and file paths, how you checked the result, what went wrong and how you fixed it, and what ${owner} corrected.`,
    "5. **It was a one-off or a quick answer**: write nothing.",
    `Reply with one line only: what you saved (name, version, path) or "nothing to save". Don't message ${owner} otherwise.`,
  ].join("\n");
}
