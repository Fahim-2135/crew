// When a thread should start a fresh Claude Code session, and what the new session is told.
//
// A thread is an agent's ongoing conversation with the user. One endless session fills up and
// gets compacted, losing detail; the agent's memory lives in the brain, not in the session.
// So a thread rotates to a new session when it grows large, and the new session gets a short
// handover of the last exchanges. "Same memory" matters more than "same window".

import { Owner } from "./owner.mjs";

export const ROTATION = Object.freeze({
  maxContextTokens: 80_000,
  maxTurns: 30,
  maxAgeMs: 3 * 24 * 60 * 60 * 1000, // autonomous threads only
  handoverExchanges: 6,
  handoverChars: 400,
});

/**
 * @param {{ lastContextTokens: number | null, turns: number, createdAt: number,
 *   agentHash: string, autonomous?: boolean }} thread
 * @param {{ now: number, agentHash: string }} context
 * @returns {null | "definition" | "context" | "turns" | "age"}
 */
export function rotationReason(thread, context) {
  if (thread.agentHash !== context.agentHash) return "definition";
  if ((thread.lastContextTokens ?? 0) > ROTATION.maxContextTokens) return "context";
  if (thread.turns >= ROTATION.maxTurns) return "turns";
  if (thread.autonomous && context.now - thread.createdAt > ROTATION.maxAgeMs) return "age";
  return null;
}

/**
 * The note that opens a rotated thread's first prompt: the last few exchanges, trimmed.
 * @param {Array<{ role: "you" | "agent" | "note", text: string }>} messages  oldest first
 * @returns {string}
 */
export function handover(messages) {
  const recent = messages
    .filter((m) => m.role !== "note")
    .slice(-ROTATION.handoverExchanges * 2)
    .map((m) => `${m.role === "you" ? Owner() : "You"}: ${trim(m.text, ROTATION.handoverChars)}`);
  if (!recent.length) return "";
  return [
    "(Crew: this continues an earlier conversation in a fresh session. The last exchanges were:)",
    ...recent,
    "(End of handover. Your memory notes are loaded as usual.)",
  ].join("\n");
}

function trim(text, max) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
