// Crew inside Claude Code: `/crew` opens the Crew window (the whole team in a sidebar, each
// agent's chat beside it), a line above the prompt says when an agent needs the user, and a toast
// says when a new request arrives or an agent replies.
//
// The mod is a thin launcher: the window is served by the Crew hub on 127.0.0.1, and approving
// or denying is a call to the hub's API. It reads the hub's local token from
// %LOCALAPPDATA%\crew\local-token, and never puts that token in a URL: the window link carries a
// one-time code the page trades for it.

import { AGENTS } from "../shared/faces.mjs";

const POLL_MS = 3000;
/** How long, after starting the hub, to keep trying to open the window. */
const START_TRIES = 15;
const START_RETRY_MS = 1000;

const TITLES = {
  ceo: "CEO",
  product: "Product",
  engineering: "Engineering",
  growth: "Growth",
  social: "Social",
  ops: "Ops",
  learning: "Learning",
  coder: "Coder",
};

/** Agents the user created carry their own names; the first eight have these. */
const titleOf = (id) => team.find((a) => a.id === id)?.title ?? TITLES[id] ?? id;

let disabled = false;
let token = null;
let home = "";
let base = "http://127.0.0.1:7788";
let hubUp = false;
/** @type {Array<{ id: string, title?: string, state: string }>} */
let team = [];
/** @type {Array<{ code: string, agent: string, summary: string }>} */
let pending = [];
let seenCodes = null;
let lastStates = {};
let lastSignature = "";

export function register(on) {
  on("session.start", async ($, e, next) => {
    // Crew's own agent runs load no user plugins, but stay silent if this mod ever lands in one,
    // and in the brain's own background jobs (mailroom, night worker).
    disabled = Boolean((await $.env.get("CREW_WORKER")) || (await $.env.get("BRAIN_WORKER")));
    if (disabled) return next(e);

    home = (await $.env.get("CREW_HOME")) || `${await $.env.get("LOCALAPPDATA")}/crew`;
    base = `http://127.0.0.1:${(await $.env.get("CREW_PORT")) || "7788"}`;
    token = await readToken($);

    await $.command.register({
      name: "crew",
      description: "Open your agent team: /crew, /crew <agent>, /crew approve|deny <code>",
      argumentHint: "[agent | approve <code> | deny <code>]",
      immediate: true,
    });

    await poll($);
    $.clock.every(POLL_MS, () => poll($));
    return next(e);
  });

  on("command.run", { command: "crew" }, async ($, e) => {
    if (disabled) return { text: "Crew is off in this session." };
    const [first, ...rest] = String(e.args ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const word = first?.toLowerCase();

    if (word === "approve" || word === "deny") {
      const code = rest[0];
      if (!code) return { text: `usage: /crew ${word} <code>` };
      return { text: await decideApproval($, code, word, rest.slice(1).join(" ")) };
    }
    // The hub's list includes agents the user created; the first eight are known even offline.
    const known = team.length ? team.map((a) => a.id) : AGENTS;
    if (word && !known.includes(word)) {
      return { text: `No agent named ${word}. The team: ${known.join(", ")}.` };
    }

    const where = word ? `${titleOf(word)}'s chat` : "the Crew window";
    if (await openWindow($, word)) return { text: `Opened ${where}.` };

    // The hub is down (or has no token yet): start it, and open the window once it answers.
    const started = await startHub($);
    if (!started) return { text: "Could not start the Crew hub. Try `crew start` in a terminal." };
    openWhenUp($, word, START_TRIES);
    return { text: `Starting the Crew hub… ${where} opens in a moment.` };
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (disabled || !hubUp) return next(e);
    const line = bandLine();
    if (!line) return next(e);
    const { Text } = $.ui.resolve(e);
    return Text({
      wrap: "truncate-end",
      ...(line.asking ? { color: "#FF9F1C" } : {}),
      dimColor: !line.asking,
      children: [line.text],
    });
  });
}

// --- the window

/**
 * Ask the hub for a one-time code and open the window as an Edge app window (no tabs, no
 * address bar). The fragment is `<code>` or `<code>.<agent>`: nothing in it means anything to
 * cmd's `start`, which would split a URL at `&`. Resolves false when the hub can't be reached.
 */
async function openWindow($, agent) {
  if (!token) token = await readToken($);
  if (!token) return false;
  let code;
  try {
    ({ code } = await call($, "POST", "/v1/window/code"));
  } catch {
    return false;
  }
  const url = `${base}/#${code}${agent ? `.${agent}` : ""}`;
  await $.process.run(
    [
      "cmd",
      "/c",
      "start",
      "",
      "msedge",
      `--app=${url}`,
      "--window-size=1000,600",
      "--window-position=80,40",
    ],
    { timeoutMs: 15_000 },
  );
  return true;
}

function openWhenUp($, agent, triesLeft) {
  $.clock.after(START_RETRY_MS, async () => {
    if (await openWindow($, agent)) {
      await poll($);
      return;
    }
    if (triesLeft > 1) openWhenUp($, agent, triesLeft - 1);
    else
      $.ui.toast("The Crew hub didn't start. Try `crew start` in a terminal.", { timeoutMs: 8000 });
  });
}

async function startHub($) {
  try {
    await $.process.run(
      [
        "cmd",
        "/c",
        "start",
        "Crew hub",
        "/MIN",
        "node",
        `${$.plugin.root}/hub/bin/crew.mjs`,
        "start",
      ],
      { timeoutMs: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

// --- talking to the hub

async function readToken($) {
  try {
    return String(await $.fs.read(`${home}/local-token`)).trim() || null;
  } catch {
    return null;
  }
}

/** One authenticated call to the hub; resolves to the parsed body, or throws. */
async function call($, method, path, body) {
  const res = await $.http.fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed;
  try {
    parsed = JSON.parse(res.text || "{}");
  } catch {
    parsed = {}; // a body that is not JSON carries no fields
  }
  if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
  return parsed;
}

/** Refresh the team and the pending approvals; tell the user what changed. */
async function poll($) {
  if (disabled || !token) return;
  try {
    const [agents, approvals] = await Promise.all([
      call($, "GET", "/v1/agents"),
      call($, "GET", "/v1/approvals?status=pending"),
    ]);
    hubUp = true;
    team = agents.agents ?? [];
    pending = approvals.approvals ?? [];

    // A new request, or an agent that just finished, is worth a toast; the first poll only
    // learns what is already there.
    if (seenCodes) {
      for (const a of pending) {
        if (!seenCodes.has(a.code))
          $.ui.toast(`${titleOf(a.agent)} needs you: ${a.summary}`, { timeoutMs: 8000 });
      }
      for (const a of team) {
        if (lastStates[a.id] === "working" && a.state === "done") {
          $.ui.toast(`${titleOf(a.id)} replied. /crew ${a.id}`, { timeoutMs: 6000 });
        }
      }
    }
    seenCodes = new Set(pending.map((a) => a.code));
    lastStates = Object.fromEntries(team.map((a) => [a.id, a.state]));
  } catch {
    hubUp = false;
  }
  // Redraw only on a change: an unchanged redraw every few seconds makes the classic
  // renderer reprint the screen.
  const signature = JSON.stringify([hubUp, bandLine()]);
  if (signature !== lastSignature) {
    lastSignature = signature;
    $.ui.invalidate("ui.render");
  }
}

async function decideApproval($, code, decision, note) {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  try {
    const { approval } = await call($, "POST", `/v1/approvals/${code}/decision`, {
      decision,
      nonce,
      note: note || undefined,
    });
    return `${approval.code}: ${approval.status}${approval.result ? ` — ${approval.result}` : ""}`;
  } catch (err) {
    return `${code}: ${err?.message ?? err}`;
  }
}

function bandLine() {
  const waiting = pending[0];
  if (waiting) {
    const more = pending.length > 1 ? ` (+${pending.length - 1} more)` : "";
    return {
      asking: true,
      text: `crew · ${titleOf(waiting.agent)} needs you: ${waiting.summary} (${waiting.code})${more} · /crew ${waiting.agent}`,
    };
  }
  const working = team.filter((a) => a.state === "working").map((a) => titleOf(a.id));
  if (working.length) return { asking: false, text: `crew · ${working.join(", ")} working…` };
  return null;
}
