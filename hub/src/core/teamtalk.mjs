// Agents talking to each other. Two ways:
//   - a handoff: a request file in a teammate's inbox. Crew wakes the teammate, and when the
//     work is done sends the result back to whoever asked (a reply), so they can carry on.
//   - a question: ask_teammate mid-task. Crew runs the teammate at once and hands the answer
//     back to the waiting agent.
// Both show up as team lines in the two agents' chats. Pure.

import { Owner } from "./owner.mjs";

/** How long an agent waits for a teammate's answer before carrying on without it. */
export const ASK_WAIT_MS = 10 * 60_000;

/** Replies that wake the asker, per pair of agents: a back-and-forth can't run forever. */
export const REPLY_LIMIT = Object.freeze({ count: 6, perMs: 60 * 60_000 });

const one = (s, n) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= n) return t;
  // Cut at a word, and never inside a [link](url) or **bold**.
  let cut = t.slice(0, n - 1).replace(/\s+\S*$/, "");
  cut = cut.replace(/\[[^\]]*(\]\([^)]*)?$/, "");
  if ((cut.match(/\*\*/g) ?? []).length % 2) cut = cut.replace(/\*\*(?!.*\*\*)/, "");
  return `${cut.trimEnd()}…`;
};

/** The first line of a request that says what it is (skips front matter and headings). */
export function requestSummary(text) {
  const body = String(text ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const line = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  return one(line ?? "", 160);
}

/**
 * The lines both chats show.
 * @param {"handoff" | "reply" | "ask" | "answer"} kind
 * @param {{ fromTitle: string, toTitle: string, text: string }} p
 * @returns {{ forFrom: string, forTo: string }}
 */
export function teamLines(kind, { fromTitle, toTitle, text }) {
  const t = one(text, kind === "reply" || kind === "answer" ? 400 : 200);
  switch (kind) {
    case "handoff":
      return { forFrom: `→ Asked ${toTitle}: ${t}`, forTo: `← ${fromTitle} asked: ${t}` };
    case "ask":
      return { forFrom: `→ Asked ${toTitle}, waiting: ${t}`, forTo: `← ${fromTitle} asks: ${t}` };
    case "reply":
      return { forFrom: `← ${toTitle} replied: ${t}`, forTo: `→ Replied to ${fromTitle}` };
    case "answer":
      return { forFrom: `← ${toTitle} answered: ${t}`, forTo: `→ Answered ${fromTitle}` };
    default:
      throw new Error(`unknown team line ${kind}`);
  }
}

/** What the requester is told when a teammate has finished its handoff. */
export function replyPrompt({ byTitle, path, result }) {
  return [
    `Crew: ${byTitle} finished the request you sent (${path}). Their reply:`,
    "",
    String(result ?? "").trim(),
    "",
    `If this completes something you are doing, carry on with it: combine it, hand the next step to whoever owns it, or tell ${Owner()} what's ready. Don't send the same request back. If nothing more is needed, say so in one line.`,
  ].join("\n");
}

/** What the teammate is told when someone asks it mid-task. */
export function askPrompt({ fromTitle, question }) {
  return [
    `Crew: ${fromTitle} is in the middle of a task and is waiting for your answer:`,
    "",
    String(question ?? "").trim(),
    "",
    `Answer it directly and completely in your reply: it goes straight back to ${fromTitle}. Use your tools and memory as you need, and keep to what was asked. You can't ask anyone else while answering.`,
  ].join("\n");
}

/**
 * Can `from` (running job `askingJob`) ask `to` now?
 * @param {{ from: string, to: string, askingJob: { kind: string }, team: string[],
 *   waiting: Set<string> }} p  waiting: agents whose run is itself waiting on an answer
 * @returns {string | null} why not, or null
 */
export function askBlocked({ from, to, askingJob, team, waiting }) {
  if (!team.includes(to)) return `no teammate named ${to}`;
  if (to === from) return "you can't ask yourself";
  if (askingJob.kind === "ask") return "you're answering a question: answer it yourself";
  if (waiting.has(to)) {
    return `${to} is waiting on a teammate itself; put the request in its inbox instead`;
  }
  return null;
}
