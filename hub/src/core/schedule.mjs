// Time rules for autonomous work: which daily routines are due, and when Crew keeps quiet.
// Pure: every function takes "now" and the local UTC offset, so tests do not depend on the
// machine's clock or time zone.

/** "09:30" -> minutes after midnight. */
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m) throw new Error(`not a time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The local calendar date, minute of the day and weekday (0 = Sunday) of an instant.
 * @param {number} nowMs
 * @param {number} offsetMinutes  local time minus UTC, e.g. 360 for Bangladesh
 */
export function localParts(nowMs, offsetMinutes) {
  const d = new Date(nowMs + offsetMinutes * 60_000);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

/** Whether a minute of the day falls in a window; windows may wrap past midnight. */
export function inWindow(minutes, window) {
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * The first window (quiet hours, the brain's night job) that blocks autonomous work now.
 * @param {number} nowMs
 * @param {number} offsetMinutes
 * @param {Array<{ name: string, from: string, to: string }>} windows
 * @returns {string | null} the blocking window's name
 */
export function blockedBy(nowMs, offsetMinutes, windows) {
  const { minutes } = localParts(nowMs, offsetMinutes);
  return windows.find((w) => inWindow(minutes, w))?.name ?? null;
}

/**
 * Routines due now: enabled, on today's weekday (when it has `days`), past their time, and not
 * yet run today. A routine whose time passed while the PC was off runs once, late, the same
 * day, unless it is more than `lateMinutes` late (a 09:00 brief is pointless at 17:00): then
 * it is skipped for the day. Nothing ever piles up across days.
 * @param {Array<{ id: string, at: string, days?: number[], enabled?: boolean }>} schedules
 * @param {Record<string, string>} lastRuns  id -> local date it last ran (or was skipped)
 * @returns {{ due: object[], skipped: object[] }}
 */
export function dueSchedules(schedules, lastRuns, nowMs, offsetMinutes, lateMinutes = 180) {
  const { date, minutes, weekday } = localParts(nowMs, offsetMinutes);
  const pending = schedules.filter(
    (s) =>
      s.enabled !== false &&
      (!s.days || s.days.includes(weekday)) &&
      minutes >= minutesOf(s.at) &&
      lastRuns[s.id] !== date,
  );
  const late = (s) => minutes - minutesOf(s.at) > lateMinutes;
  return { due: pending.filter((s) => !late(s)), skipped: pending.filter(late) };
}

/** Start of the local day containing `nowMs`, as an epoch millisecond. */
export function startOfLocalDay(nowMs, offsetMinutes) {
  const { minutes } = localParts(nowMs, offsetMinutes);
  const d = new Date(nowMs);
  return nowMs - minutes * 60_000 - d.getUTCSeconds() * 1000 - d.getUTCMilliseconds();
}
