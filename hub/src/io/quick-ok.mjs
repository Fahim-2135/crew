// Ask the user for a quick OK from inside a Crew run (the gate hook, the desktop tool): the hub
// rings their phone and shows it in the window, and this waits for their answer.

import { readFileSync } from "node:fs";
import { owner, Owner } from "../core/owner.mjs";

const POLL_MS = 2000;
const WAIT_MS = 14 * 60_000; // just under the request's own 15 minutes

/**
 * @param {{ tool: string, summary: string, reason: string }} request
 * @param {NodeJS.ProcessEnv} [env] the run's CREW_* settings
 * @returns {Promise<{ allow: boolean, reason: string }>}
 */
export async function askOwner(request, env = process.env) {
  const base = `http://127.0.0.1:${env.CREW_PORT ?? "7788"}`;
  let token = "";
  try {
    token = readFileSync(env.CREW_TOKEN_FILE ?? "", "utf8").trim();
  } catch {
    /* no token: the request below fails and the answer is no */
  }
  const call = (path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

  let approval;
  try {
    ({ approval } = await call("/v1/gate", {
      method: "POST",
      body: JSON.stringify({ jobId: Number(env.CREW_JOB), ...request }),
    }));
  } catch (err) {
    return {
      allow: false,
      reason: `Couldn't reach ${owner()} for a quick OK (${err.message}). Don't do this now; tell them what you wanted to do.`,
    };
  }

  // Already yes: the user said yes to all of these for this task.
  if (approval.status === "approved")
    return { allow: true, reason: `${Owner()} said yes to these for this task.` };
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let now;
    try {
      ({ approval: now } = await call(`/v1/approvals/${approval.id}`));
    } catch {
      continue;
    }
    if (now.status === "approved") return { allow: true, reason: `${Owner()} said yes.` };
    if (now.status === "denied") {
      return {
        allow: false,
        reason: `${Owner()} said no${now.note ? `: ${now.note}` : ""}. Don't do it; carry on without it, or ask them what they want instead.`,
      };
    }
    if (now.status === "expired") break;
  }
  return {
    allow: false,
    reason: `No answer from ${owner()} in time. Don't do it now; tell them what you wanted to do so they can say yes later.`,
  };
}
