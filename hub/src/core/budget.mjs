// Whether a job may start now, given how much of the user's Claude plan is used. Crew must never
// eat the limits they need for their own work. The thresholds are starting guesses, to be
// calibrated against real runs.

import { Owner } from "./owner.mjs";

/** Lower number = more important. */
export const PRIORITY = Object.freeze({
  user: 0, // The user's own messages and calls
  approved: 1, // work he has approved
  urgent: 2, // urgent inbox items
  schedule: 3, // daily routines
  background: 4, // everything else
});

export const LIMITS = Object.freeze({
  backgroundBelow: 0.4, // five-hour use under which background work may run
  schedulesBelow: 0.6, // ... schedules and urgent items
  autonomousBelow: 0.8, // ... approved work; above this only the user's own messages run
  weekHalveAbove: 0.6, // seven-day use above which schedules run at half rate
  weekStopAbove: 0.8, // seven-day use above which nothing autonomous runs
  stale: 30 * 60 * 1000, // a reading older than this counts as unknown
  pauseAfterLimit: 30 * 60 * 1000, // after a limit error, autonomous work waits this long
});

/**
 * @param {{ priority: number }} job
 * @param {{ fiveHour: number | null, sevenDay: number | null, at: number } | null} usage
 * @param {{ now: number, userBusy?: boolean, limitHitAt?: number | null }} context
 * @returns {{ ok: boolean, reason: string | null, warn: boolean }}
 */
export function admit(job, usage, context) {
  const p = job.priority;
  const fiveHour = usage && context.now - usage.at < LIMITS.stale ? usage.fiveHour : null;
  const sevenDay = usage && context.now - usage.at < LIMITS.stale ? usage.sevenDay : null;

  // The user's own messages always run; above the top band they carry a warning.
  if (p === PRIORITY.user) {
    return {
      ok: true,
      reason: null,
      warn: fiveHour !== null && fiveHour >= LIMITS.autonomousBelow,
    };
  }

  if (context.limitHitAt && context.now - context.limitHitAt < LIMITS.pauseAfterLimit) {
    return no("paused after a usage-limit error");
  }
  if (fiveHour === null) {
    // Unknown usage: only work they already approved.
    return p === PRIORITY.approved ? yes() : no("usage unknown");
  }
  if (sevenDay !== null && sevenDay >= LIMITS.weekStopAbove) return no("weekly usage high");
  if (p >= PRIORITY.background && context.userBusy) return no(`${Owner()} is working`);
  if (p === PRIORITY.schedule && context.userBusy) return no(`${Owner()} is working`);

  const bar =
    p === PRIORITY.approved
      ? LIMITS.autonomousBelow
      : p <= PRIORITY.schedule
        ? LIMITS.schedulesBelow
        : LIMITS.backgroundBelow;
  return fiveHour < bar ? yes() : no(`five-hour usage at ${Math.round(fiveHour * 100)}%`);
}

const yes = () => ({ ok: true, reason: null, warn: false });
const no = (reason) => ({ ok: false, reason, warn: false });

/**
 * Routines run every other day while seven-day use is high (LIMITS.weekHalveAbove): they wait
 * on odd days of the month. A reading too old to trust doesn't halve anything.
 * @param {{ sevenDay: number | null, at: number } | null} usage
 * @param {string} date  local YYYY-MM-DD
 * @param {number} now
 */
export function halfRate(usage, date, now) {
  if (!usage || usage.sevenDay == null || now - usage.at >= LIMITS.stale) return false;
  return usage.sevenDay >= LIMITS.weekHalveAbove && Number(date.slice(8, 10)) % 2 === 1;
}
