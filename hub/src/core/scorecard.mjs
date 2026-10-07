// How an agent is doing: this week against the week before, so it shows whether it is getting
// better. Numbers only from what Crew already records:
//   - real tasks: work that earned a skill review (5+ tool calls)
//   - with a skill: replies that start "Using skill:"
//   - corrections: thumbs down, quick OKs and approvals the user said no to, failed runs
//   - skills: how many it keeps, and how many times they have been improved (versions past 1)

import { REVIEWED_KINDS } from "./skills.mjs";

export const DAY_MS = 24 * 60 * 60 * 1000;

const USED_SKILL = /^\W*using skill:/i;

/**
 * @param {{ now: number, days?: number, jobs: object[], feedback: object[], approvals: object[],
 *   skills: { stage: string, version: number, playbook?: boolean }[] }} input
 */
export function scorecard({ now, days = 7, jobs, feedback, approvals, skills }) {
  const span = days * DAY_MS;
  const window = (from, to) => {
    const inside = (t) => t >= from && t < to;
    const work = jobs.filter((j) => REVIEWED_KINDS.has(j.kind) && inside(j.createdAt));
    const realTasks = jobs.filter((j) => j.kind === "review" && inside(j.createdAt)).length;
    const withSkill = work.filter(
      (j) => j.status === "done" && USED_SKILL.test(String(j.result ?? "")),
    ).length;
    const failed = work.filter((j) => j.status === "failed").length;
    const thumbsUp = feedback.filter((f) => f.rating === "up" && inside(f.at)).length;
    const thumbsDown = feedback.filter((f) => f.rating === "down" && inside(f.at)).length;
    const asked = approvals.filter((a) => inside(a.createdAt));
    const denied = asked.filter((a) => a.status === "denied").length;
    const approved = asked.filter((a) => ["approved", "executed"].includes(a.status)).length;
    const corrections = thumbsDown + denied + failed;
    return {
      tasks: work.filter((j) => j.status === "done").length,
      realTasks,
      withSkill,
      skillShare: realTasks ? Math.min(1, withSkill / realTasks) : null,
      failed,
      thumbsUp,
      thumbsDown,
      approved,
      denied,
      corrections,
      correctionsPerTask: realTasks ? corrections / realTasks : null,
    };
  };
  const kept = skills.filter((s) => s.stage === "skill");
  return {
    days,
    week: window(now - span, now + 1),
    before: window(now - 2 * span, now - span),
    skills: {
      skills: kept.length,
      records: skills.filter((s) => s.stage === "record").length,
      improvements: kept.reduce((n, s) => n + Math.max(0, (Number(s.version) || 1) - 1), 0),
    },
  };
}

/** Whether corrections per task went down, up or stayed (null without enough work). */
export function trend(card) {
  const now = card.week.correctionsPerTask;
  const then = card.before.correctionsPerTask;
  if (now == null || then == null) return null;
  if (now < then) return "better";
  if (now > then) return "worse";
  return "same";
}

/** One plain line for a prompt or a notice. */
export function scoreLine(card) {
  const w = card.week;
  const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
  return [
    `${w.realTasks} real task${w.realTasks === 1 ? "" : "s"} in ${card.days} days`,
    `${pct(w.skillShare)} done with a skill`,
    `${w.corrections} correction${w.corrections === 1 ? "" : "s"} (${w.thumbsDown} thumbs down, ${w.denied} said no, ${w.failed} failed)`,
    `the ${card.days} days before: ${card.before.realTasks} real task${card.before.realTasks === 1 ? "" : "s"}, ${card.before.corrections} correction${card.before.corrections === 1 ? "" : "s"}`,
    `${card.skills.skills} skills, improved ${card.skills.improvements} times, ${card.skills.records} records waiting`,
  ].join("; ");
}

/**
 * The weekly look-back: the agent reads its numbers and corrections and improves its skills.
 * @param {{ agent: string, brain: string, today: string, owner: string, card: object,
 *   corrections: string[] }} input
 */
export function retroPrompt({ agent, brain, today, owner, card, corrections }) {
  const root = `${brain.replace(/\\/g, "/")}/departments/${agent}/skills`;
  return [
    `Crew weekly look-back (${today}). How your week went: ${scoreLine(card)}.`,
    corrections.length
      ? [
          "What went wrong or what " + owner + " corrected:",
          ...corrections.map((c) => `- ${c}`),
        ].join("\n")
      : `${owner} corrected nothing this week.`,
    [
      "Make next week better:",
      `1. Read your skills in ${root} (SKILL.md and CHANGELOG.md) and your recent chats. Fold every correction above into the skill it belongs to (copy SKILL.md to history/v<old>.md, raise \`version\`, set \`updated: ${today}\`, add a CHANGELOG.md line).`,
      "2. Turn any record you have used twice into a skill; merge skills that overlap; make each skill's `description` say plainly which requests it is for.",
      "3. If the same mistake keeps coming back because of your standing instructions, propose one change with request_approval type agent.update.",
      `Reply with one line: what you improved (skill names and new versions), or "nothing to improve". Don't message ${owner} otherwise.`,
    ].join("\n"),
  ].join("\n\n");
}
