// Checks agents schedule for themselves (Dots-style): while working, an agent notices something
// that could go wrong later and leaves itself a check ("at 08:00, see whether the cab booking was
// cancelled; tell Fahim only if it was"). The hub stores it and runs it when it is due.
//
// Shapes: once (`when`), or every N hours/days until an end (`every` + `until`, at most 30 days).
// Open-ended repeating checks are left for later: they would need the user's OK.

export const LIMITS = Object.freeze({
  perAgent: 10, // open checks per agent
  minEveryMs: 60 * 60 * 1000, // repeat no more often than hourly
  maxAheadMs: 60 * 24 * 60 * 60 * 1000, // a first run at most 60 days ahead
  maxSpanMs: 30 * 24 * 60 * 60 * 1000, // a repeating check ends within 30 days
});

const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30m", "2h", "3 days", "1 day" → ms, or null. */
export function duration(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)\s*$/i.exec(
    String(text ?? ""),
  );
  if (!m) return null;
  const unit = m[2][0].toLowerCase();
  return Math.round(Number(m[1]) * UNIT[unit]);
}

/**
 * When a check should run: "in 2h", an ISO time with an offset, or a local "YYYY-MM-DD HH:MM"
 * (read in the user's time zone). Returns ms, or null when it can't be read.
 * @param {string} text
 * @param {number} now
 * @param {number} offsetMinutes the user's time zone (minutes east of UTC)
 */
export function parseWhen(text, now, offsetMinutes) {
  const t = String(text ?? "").trim();
  const rel = /^in\s+(.+)$/i.exec(t);
  if (rel) {
    const ms = duration(rel[1]);
    return ms == null ? null : now + ms;
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(t);
  if (!local) return null;
  const [, y, mo, d, h, mi] = local.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - offsetMinutes * 60_000;
}

/**
 * Check a new check's timing; returns { at, every, until } or throws a plain message.
 * @param {{ when: string, every?: string, until?: string }} input
 */
export function planCheck(input, now, offsetMinutes) {
  const at = parseWhen(input.when, now, offsetMinutes);
  if (at == null) {
    throw new Error('say when as "in 2h", "in 3 days", or a local time "YYYY-MM-DD HH:MM"');
  }
  if (at < now - 60_000) throw new Error("that time has already passed");
  if (at - now > LIMITS.maxAheadMs) throw new Error("a check can start at most 60 days ahead");
  if (!input.every) {
    if (input.until) throw new Error("`until` goes with `every`");
    return { at, every: null, until: null };
  }
  const every = duration(input.every);
  if (every == null) throw new Error('say every as "3h", "1 day", ...');
  if (every < LIMITS.minEveryMs) throw new Error("repeat at most once an hour");
  const until = input.until ? parseWhen(input.until, now, offsetMinutes) : null;
  if (until == null) {
    throw new Error("a repeating check needs `until` (when to stop), at most 30 days away");
  }
  if (until <= at) throw new Error("`until` must come after the first run");
  if (until - now > LIMITS.maxSpanMs) throw new Error("a repeating check ends within 30 days");
  return { at, every, until };
}

/** The next run after one at `at`, or null when the check is finished. */
export function nextRun(check) {
  if (!check.every) return null;
  const next = check.at + check.every;
  return next <= check.until ? next : null;
}

/** A check reply that found nothing for the user: kept as a quiet note. */
export function allFine(reply) {
  return /^\W*all fine\b/i.test(String(reply ?? "").trim());
}

/** A check reply saying the thing it watched for is settled: no more runs. */
export function finished(reply) {
  return /\bcheck finished\b/i.test(String(reply ?? ""));
}

const short = (text, max) => {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The prompt a check runs with.
 * @param {{ check: object, owner: string, when: string }} input  when: the date it was set
 */
export function checkPrompt({ check, owner, when }) {
  const repeat = check.every
    ? ` It repeats until ${new Date(check.until).toISOString().slice(0, 16).replace("T", " ")} UTC; this is run ${check.runs + 1}.`
    : "";
  return [
    `Scheduled check you set on ${when}${check.why ? ` (${short(check.why, 200)})` : ""}.${repeat}`,
    `What to do now: ${check.what}`,
    "Do it now, reading whatever you need (email, calendar, the browser, files). Reading needs no OK.",
    `- If nothing needs ${owner}, reply with one line starting \`All fine:\` and what you saw.`,
    `- If something needs ${owner}, say it plainly in two or three lines: what happened and what you suggest. Don't act on anything that can't be undone without their quick OK.`,
    check.every
      ? "- If what you were watching for is settled and the check needn't run again, end your reply with `Check finished`."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The part of every run's instructions that teaches agents to schedule their own checks. */
export function checksNote() {
  return [
    "# Checks you schedule yourself",
    "You can leave yourself a check for later with the crew tool schedule_check: Crew runs it when it is due, even if nobody has talked to you since. Do it on your own, without asking, whenever:",
    "- something in a chat has a time ahead that could go wrong (a booking, a meeting, a deadline): check a little before it;",
    "- you are waiting on someone (an email you sent, a request): check after a sensible wait and tell them if nothing came;",
    "- you shipped or posted something whose result matters (a post's reach after 2h and 24h, errors after a release): check the result and learn from it (update your skill);",
    "- something failed for now (a site was down, a limit was hit): try again later.",
    "Write `what` as full instructions to your future self (it won't remember this chat): what to look at, where, and what counts as a problem. Don't schedule checks for things you can do now. list_checks shows yours; cancel_check removes one that is no longer needed. Mention a new check in your reply in one short line.",
  ].join("\n");
}
