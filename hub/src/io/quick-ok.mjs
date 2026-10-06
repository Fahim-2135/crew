// Ask the user for a quick OK from inside a Crew run (the gate hook, the desktop tool): the hub
// rings their phone and shows it in the window, and this waits for their answer.

import { readFileSync } from "node:fs";
import { owner, Owner } from "../core/owner.mjs";

const POLL_MS = 2000;
const WAIT_MS = 14 * 60_000; // just under the request's own 15 minutes
const FACE_URL = "http://127.0.0.1:7777/state"; // claude-face, if it's running

/**
 * Tell claude-face (if it's running) this run is waiting on the user, or working again. Its own
 * hook only sees Claude Code's permission prompts, not Crew's quick OKs. Best effort: never waits
 * long, never fails the run.
 * @param {"asking" | "working"} state
 * @param {{ session_id?: string, cwd?: string, transcript?: string } | undefined} face
 * @param {NodeJS.ProcessEnv} env
 */
export async function faceSignal(state, face, env = process.env, url = FACE_URL) {
  if (!face?.session_id) return;
  const body = {
    session_id: face.session_id,
    state,
    cwd: face.cwd,
    transcript: face.transcript,
    ...(env.CREW_AGENT && env.CREW_CLI
      ? {
          crew: {
            agent: env.CREW_AGENT,
            cli: env.CREW_CLI,
            node: env.CREW_NODE,
            icon: env.CREW_ICON,
            title: env.CREW_TITLE,
          },
        }
      : {}),
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* no claude-face: nothing to tell */
  }
}

/**
 * @param {{ tool: string, summary: string, reason: string, grant?: string,
 *   face?: { session_id?: string, cwd?: string, transcript?: string } }} request
 *   face: the Claude Code session, so claude-face can show it needs the user while it waits
 * @param {NodeJS.ProcessEnv} [env] the run's CREW_* settings
 * @param {{ faceUrl?: string }} [opts]
 * @returns {Promise<{ allow: boolean, reason: string }>}
 */
export async function askOwner(request, env = process.env, opts = {}) {
  const { face, ...ask } = request;
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
      body: JSON.stringify({ jobId: Number(env.CREW_JOB), ...ask }),
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
  await faceSignal("asking", face, env, opts.faceUrl);
  try {
    return await waitFor(approval, call);
  } finally {
    await faceSignal("working", face, env, opts.faceUrl);
  }
}

async function waitFor(approval, call) {
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
