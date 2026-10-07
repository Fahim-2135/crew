// Talking to an agent while it works, and seeing how far it is.
//
// Tweaks: a message the user sends with "Tell it now" while the agent is mid-task goes to that
// run instead of the queue. Crew's tweak hook (io/tweak-hook.mjs) hands it to the agent after
// the step it is on (PostToolUse), or, when the agent is about to finish, keeps it going (Stop).
// A plain message still waits for the task to end.
//
// Progress: on a bigger task the agent keeps a short checklist with the crew tool set_progress;
// the window and the phone show it under the agent's "working" line.

export const MAX_STEPS = 12;

/** The text the agent reads for the tweaks it was sent. */
export function tweakContext(texts, owner) {
  const lines = texts.map((t) => `- ${String(t).trim()}`).join("\n");
  return [
    `${owner} sent you this while you were working (a change to the task you are on, typed after their request):`,
    lines,
    "Take it into account from your next step on; if it changes work you have already done, redo what it affects. Don't stop to ask unless it truly conflicts with the request. If they asked where you are, answer in one line and carry on.",
  ].join("\n");
}

/**
 * A checklist from set_progress: up to 12 steps, each a short text and a status.
 * @param {unknown} steps
 * @returns {{ text: string, status: "todo" | "doing" | "done" }[]}
 */
export function cleanSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error("give the steps as a list");
  return steps.slice(0, MAX_STEPS).map((s) => {
    const text = String(typeof s === "string" ? s : (s?.text ?? ""))
      .trim()
      .slice(0, 120);
    if (!text) throw new Error("every step needs a short text");
    const status = ["todo", "doing", "done"].includes(s?.status) ? s.status : "todo";
    return { text, status };
  });
}

/** The lines every run gets about tweaks and the checklist. */
export function tweaksNote(owner) {
  return [
    "# While you work",
    `${owner} can send you a note mid-task; it reaches you after a step as a system note. Treat it as their words and adjust from your next step.`,
    "On a bigger task (three or more distinct parts, or anything that takes more than a few minutes), call the crew tool set_progress with your plan as a short checklist at the start, and again whenever a step starts or finishes, so they can see how far you are without interrupting you.",
  ].join("\n");
}
