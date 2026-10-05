// The morning report: what Crew did since the last report, from the event log. No model.

/**
 * @param {Array<{ type: string, at: number, data: any }>} events  since the last report
 * @param {{ jobs: Map<number, { agent: string, kind: string, result?: string | null }> }} lookup
 * @returns {{ lines: string[], counts: { done: number, failed: number, woken: number, mail: number } }}
 */
export function buildReport(events, lookup) {
  const counts = { done: 0, failed: 0, woken: 0, mail: 0 };
  const byAgent = new Map();
  const failures = [];

  for (const e of events) {
    if (e.type === "inbox.woke") counts.woken += 1;
    if (e.type === "job.done") {
      const job = lookup.jobs.get(e.data.jobId);
      if (!job || job.kind === "chat") continue;
      if (job.kind === "system") {
        counts.mail += 1;
        continue;
      }
      counts.done += 1;
      byAgent.set(job.agent, (byAgent.get(job.agent) ?? 0) + 1);
    }
    if (e.type === "job.failed") {
      const job = lookup.jobs.get(e.data.jobId);
      if (!job || job.kind === "chat") continue;
      counts.failed += 1;
      failures.push(`${job.agent}: ${e.data.error ?? "failed"}`);
    }
  }

  const lines = [];
  if (!counts.done && !counts.failed && !counts.woken && !counts.mail) {
    lines.push("Quiet since the last report: nothing new came in and nothing ran.");
  } else {
    if (counts.woken) lines.push(`${counts.woken} new inbox item${s(counts.woken)} woke an agent.`);
    if (counts.done) {
      const who = [...byAgent].map(([a, n]) => (n > 1 ? `${a} ×${n}` : a)).join(", ");
      lines.push(`${counts.done} job${s(counts.done)} finished: ${who}.`);
    }
    if (counts.mail) lines.push(`Mail checked ${counts.mail} time${s(counts.mail)}.`);
    if (counts.failed) lines.push(`${counts.failed} failed: ${failures.slice(0, 3).join("; ")}.`);
  }
  return { lines, counts };
}

const s = (n) => (n === 1 ? "" : "s");
