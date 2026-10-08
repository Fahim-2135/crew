// Carrying on after the plan's usage limit: a task the limit cut off starts again 5 minutes
// after the limit resets, in the same conversation, without anyone asking.

/** Work worth picking up again (not a review, look-back or approval note). */
export const RESUMABLE_KINDS = new Set([
  "chat",
  "call",
  "inbox",
  "schedule",
  "reply",
  "ask",
  "check",
]);

/** Wait this long past the reset, so the window is surely open again. */
export const AFTER_RESET_MS = 5 * 60_000;

/** When the reset time is unknown, try again after this long. */
export const UNKNOWN_RESET_MS = 60 * 60_000;

/**
 * When to pick the task up again: 5 minutes after the limit resets.
 * @param {{ which: string, until: number | null } | null} limit  hub.limit()
 * @param {number} now
 */
export function resumeAt(limit, now) {
  const reset = limit?.until && limit.until > now ? limit.until : now + UNKNOWN_RESET_MS;
  return reset + AFTER_RESET_MS;
}

/** The prompt that picks the task up again (the session still holds everything done so far). */
export function resumePrompt(original) {
  const earlier = String(original ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const quoted = earlier.length > 400 ? `${earlier.slice(0, 399)}…` : earlier;
  return [
    "The plan's usage limit stopped you in the middle of this task, and it has reset now.",
    "Carry on where you left off: check what you already finished (files, renders, notes) instead of starting over, then finish the task.",
    quoted ? `The task was: "${quoted}"` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
