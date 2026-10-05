// Crew's settings: the daily routines, quiet hours, and which inboxes wake their department.
// Defaults live here; %LOCALAPPDATA%\crew\config.json overrides any top-level key.

import { STARTER_TEAM } from "./agents.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  // The person the agents work for (set by `crew setup`); agents call them "the user" without it.
  owner: null,
  // The agents with faces and threads: [{ id, title }]. Agents made with New agent are added.
  team: STARTER_TEAM,
  // Where the brain lives and where Claude Code finds the agents' definitions (null: defaults,
  // ~/crew-brain and ~/.claude/agents/crew).
  brain: null,
  agentsDir: null,
  // Put before an agent's id in the name Claude Code knows it by (crew-ceo), so Crew's agents
  // never shadow agents the user already has, or their memory folders. "" for none.
  agentPrefix: "crew-",
  schedules: [
    {
      id: "morning-report",
      report: true,
      at: "08:30",
    },
    {
      id: "ceo-brief",
      agent: "ceo",
      at: "09:00",
      prompt:
        "Crew morning brief. In at most six short lines for the person you work for: today's single top priority, anything waiting on them (open inbox items or decisions), and the one thing each busy department should do today. Read inboxes and recent notes as you need. Do not write any files.",
    },
  ],
  // No autonomous work in these windows. The user's own messages still run.
  quiet: [{ name: "quiet hours", from: "01:00", to: "08:00" }],
  inbox: {
    enabled: true,
    // Which agents a new inbox item wakes; null means every agent on the team.
    departments: null,
  },
  // No daily cap on runs Crew starts by itself: the usage guard (budget.mjs) protects the plan.
  maxAutonomousPerDay: null,
  // Agents working at the same time (each agent one run at a time). A call may take one more.
  maxRuns: 3,
  // true turns on the usage caps in budget.mjs: work Crew starts by itself steps back as the
  // Claude plan fills up (the user's own messages are never capped). Off by default.
  budgetGuard: false,
  // Quick OKs and notices as desktop notifications (for people without the phone app).
  desktopNotify: true,
  // The Crew phone app (pairing, push, calls): off unless set up.
  phones: false,
});

/** System jobs: brain scripts the hub runs in a run slot, one of each at a time. */
export const SYSTEM_SCRIPTS = Object.freeze({
  mailroom: { script: "tools/mail-triage.mjs", timeoutMs: 10 * 60_000 },
});

/**
 * Merge a user config over the defaults (top-level keys replace).
 * @param {object | null} user
 */
export function resolveConfig(user) {
  return { ...DEFAULT_CONFIG, ...(user && typeof user === "object" ? user : {}) };
}
