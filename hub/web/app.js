// The Crew window: the team in a sidebar, one agent's chat beside it. Everything comes from
// the hub's API on this machine. `/crew` and `crew open` put a one-time code in the URL
// fragment; the page trades it for the key, keeps the key in this window's storage, and wipes
// the code from the address.

import { CRITTERS, ICON_NAMES, faceSVG, iconFor } from "/faces.mjs";
import { splitLinks } from "/links.mjs";

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
const STATE_WORDS = {
  idle: "resting",
  working: "working…",
  asking: "needs you",
  done: "done",
  limit: "out of usage",
};
/** The tag beside an agent in the sidebar, for the states worth a glance. */
const STATE_PILLS = { working: "working", asking: "needs you", limit: "limit" };

const $ = (id) => document.getElementById(id);
/** Agents the user created carry their own names; the first eight have these. */
const titleOf = (id) => state.agents.find((a) => a.id === id)?.title ?? TITLES[id] ?? id;
const state = {
  token: null,
  agents: [],
  approvals: [],
  usage: null,
  selected: null,
  messages: {},
  sending: false,
  /** Files waiting to go with the next message: { key, file, status, meta, preview }. */
  pending: [],
  seq: 0,
  /** The plan's usage limit while it is reached: { which, until }. */
  limit: null,
};

// ---- the key

/**
 * Window links (`crew open`, `/crew`) end in `#<code>` or `#<code>.<agent>`, where the code is a
 * one-time code: trade it for the key and wipe it from the address.
 */
async function takeToken() {
  const [code, agent] = location.hash.slice(1).split(".");
  if (location.hash) history.replaceState(null, "", location.pathname);
  if (agent) localStorage.setItem("crew-agent", agent);
  if (code) {
    const res = await fetch("/v1/window/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).catch(() => null);
    const body = res?.ok ? await res.json() : null;
    if (body?.token) localStorage.setItem("crew-token", body.token);
  }
  return localStorage.getItem("crew-token");
}

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${state.token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem("crew-token");
    showLocked();
    throw new Error("wrong key");
  }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function showLocked() {
  $("locked").hidden = false;
}

// ---- faces

/**
 * Draw every face on the page: a Critter (faces.mjs) that moves with CSS for its state. An
 * element can fix its own icon or state (the icon pickers, reply avatars); otherwise it shows
 * the agent's own icon and current state.
 */
function paintFaces() {
  for (const el of document.querySelectorAll("[data-face]")) {
    const agent = el.dataset.face;
    const me = state.agents.find((a) => a.id === agent);
    const mood = el.dataset.mood ?? me?.state ?? "idle";
    const icon = iconFor(agent, el.dataset.icon ?? me?.icon ?? null);
    const key = `${icon}:${mood}`;
    if (el.dataset.drawn === key) continue;
    // Faces are built from fixed drawings (faces.mjs); no outside text reaches innerHTML.
    el.innerHTML = faceSVG(icon, mood, { label: CRITTERS[icon].label });
    el.dataset.state = mood;
    el.dataset.drawn = key;
  }
}

/** A small line icon, built as nodes. */
function lineIcon(d) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

const THUMB_UP =
  "M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0l4-8a2.5 2.5 0 0 1 2.5 2.5V8h5.3a2 2 0 0 1 2 2.3l-1.3 8.5a2 2 0 0 1-2 1.7H7";
const THUMB_DOWN =
  "M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3zm0 0l-4 8a2.5 2.5 0 0 1-2.5-2.5V16H5.2a2 2 0 0 1-2-2.3l1.3-8.5a2 2 0 0 1 2-1.7H17";

// ---- drawing

/** When something happened, as the sidebar shows it: 9:14 PM, Yesterday, Fri, or 3 Oct. */
function whenText(at) {
  const d = new Date(at);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** One agent in the sidebar: its face, name, last line, when, and a tag for its state. */
function memberButton(a, { line, wants, index }) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = wants ? "member wants" : "member";
  button.setAttribute("aria-current", String(a.id === state.selected && !wants));
  button.title = index ? `${titleOf(a.id)} (${index})` : titleOf(a.id);
  button.addEventListener("click", () => select(a.id));

  const face = document.createElement("span");
  face.className = "face";
  face.dataset.face = a.id;

  const text = document.createElement("span");
  text.className = "member-text";
  const name = document.createElement("span");
  name.className = "member-name";
  name.textContent = titleOf(a.id);
  const sub = document.createElement("span");
  sub.className = "member-line";
  sub.textContent = line;
  text.append(name, sub);

  const meta = document.createElement("span");
  meta.className = "member-meta";
  if (a.lastAt && !wants) meta.append(document.createTextNode(whenText(a.lastAt)));
  const pill = wants ? STATE_PILLS.asking : STATE_PILLS[a.state];
  if (pill) {
    const tag = document.createElement("span");
    tag.className = `pill ${wants ? "asking" : a.state}`;
    tag.textContent = pill;
    meta.append(tag);
  }

  button.append(face, text, meta);
  li.append(button);
  return li;
}

function renderTeam() {
  const list = $("team");
  const filter = $("find").value.trim().toLowerCase();
  // Rebuild only on a real change: replacing the buttons under a click can swallow it.
  const shape = JSON.stringify([state.selected, state.agents, state.approvals, filter]);
  if (shape === list.dataset.shape) return;
  list.dataset.shape = shape;

  // Requests waiting on the user, first.
  const waiting = state.approvals;
  $("needs-box").hidden = waiting.length === 0;
  $("needs-label").textContent = `Needs you · ${waiting.length}`;
  $("needs").replaceChildren(
    ...waiting.map((r) => {
      const a = state.agents.find((x) => x.id === r.agent) ?? { id: r.agent, state: "asking" };
      return memberButton(a, { line: `${r.summary} · ${r.code}`, wants: true });
    }),
  );

  const shown = state.agents.filter(
    (a) => !filter || titleOf(a.id).toLowerCase().includes(filter) || a.id.includes(filter),
  );
  list.replaceChildren(
    ...shown.map((a) =>
      memberButton(a, {
        line:
          a.created && a.memory !== "synced"
            ? "New · sync its memory"
            : (a.lastLine ?? STATE_WORDS[a.state] ?? ""),
        index: state.agents.indexOf(a) + 1,
      }),
    ),
  );
  const u = state.usage;
  const pct = (x) => (x == null ? "?" : `${Math.round(x * 100)}%`);
  const usage = $("usage");
  usage.classList.toggle("limit", Boolean(state.limit));
  if (state.limit) {
    const until = state.limit.until
      ? ` · back ${new Date(state.limit.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "";
    usage.textContent = `${state.limit.which === "weekly" ? "weekly" : "5-hour"} limit${until}`;
    usage.title = "Your Claude plan's usage limit is reached: the agents wait until it resets";
  } else {
    usage.textContent = `${pct(u?.fiveHour)} · wk ${pct(u?.sevenDay)}`;
    usage.title = "Your Claude plan use: this 5-hour window, and this week";
  }
  document.title = waiting.length ? `(${waiting.length}) Crew` : "Crew";
  paintFaces();
}

function renderThread() {
  const agent = state.selected;
  $("empty").hidden = Boolean(agent);
  $("thread").hidden = !agent;
  if (!agent) return;

  const me = state.agents.find((a) => a.id === agent) ?? { state: "idle" };
  $("thread-face").dataset.face = agent;
  $("thread-name").textContent = titleOf(agent);
  $("thread-state").textContent =
    (STATE_WORDS[me.state] ?? me.state) + (me.queued ? ` · ${me.queued} queued` : "");
  $("thread-state").className = `thread-state ${me.state}`;
  $("input").placeholder = `Message ${titleOf(agent)}…`;
  // A new agent gets its memory once, on the user's word.
  const sync = $("sync-memory");
  sync.hidden = !me.created || me.memory === "synced";
  sync.disabled = me.memory === "syncing";
  sync.textContent = me.memory === "syncing" ? "Syncing memory…" : "Sync memory";

  renderApprovals(agent);

  const list = $("messages");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const msgs = state.messages[agent] ?? [];
  const last = msgs.at(-1);
  // Rebuild only when something changed: a rebuild restarts the faces' motion.
  const working = me.state === "working";
  $("send-now").hidden = !working;
  $("input").placeholder = working
    ? `Message… waits until ${titleOf(agent)} finishes (Alt+Enter: tell it now)`
    : "Message…";
  const key = JSON.stringify([agent, msgs.length, last?.id, last?.text, working, me.progress]);
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    const items = msgs.map((m) => messageItem(agent, m));
    if (me.state === "working") {
      items.push(
        messageItem(agent, {
          role: "typing",
          text: `${titleOf(agent)} is working…`,
          steps: me.progress,
        }),
      );
    }
    list.replaceChildren(...items);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  paintFaces();
}

function messageItem(agent, m) {
  const li = document.createElement("li");
  li.className = `message ${m.role === "team" ? "team-line" : m.role}`;
  const who = document.createElement("div");
  who.className = "who";
  if (m.role === "agent" || m.role === "typing") {
    // Its little face beside the reply: awake and friendly, or at work while it types.
    who.classList.add("face");
    who.dataset.face = agent;
    if (m.role === "agent") who.dataset.mood = "smile";
    who.setAttribute("aria-hidden", "true");
  }
  const body = document.createElement("div");
  body.className = "body";
  if (m.text) body.append(...formatText(m.text));
  if (m.attachments?.length) body.append(attachmentList(m.attachments));
  if (m.steps?.length) {
    const list = document.createElement("ul");
    list.className = "checklist";
    for (const step of m.steps) {
      const item = document.createElement("li");
      item.className = step.status;
      item.textContent = step.text;
      list.append(item);
    }
    body.append(list);
  }
  li.append(who, body);
  if (m.role === "agent" && m.id) li.append(feedbackButtons(agent, m.id));
  return li;
}

/** The user's verdict on a reply: a thumbs down makes the agent review how it works. */
const rated = new Map();
function feedbackButtons(agent, messageId) {
  const row = document.createElement("div");
  row.className = "feedback";
  const done = rated.get(messageId);
  if (done) {
    row.textContent = done === "up" ? "Thanks." : "Noted: it will review how it works.";
    return row;
  }
  for (const [rating, path, hint] of [
    ["up", THUMB_UP, "Good reply"],
    ["down", THUMB_DOWN, "Not right: the agent reviews how it works"],
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.append(lineIcon(path));
    b.title = hint;
    b.setAttribute("aria-label", hint);
    b.addEventListener("click", async () => {
      const note = rating === "down" ? (prompt("What was wrong? (optional)") ?? "") : "";
      try {
        await api(`/v1/threads/${agent}/feedback`, {
          method: "POST",
          body: JSON.stringify({ messageId, rating, note }),
        });
        rated.set(messageId, rating);
        row.replaceWith(feedbackButtons(agent, messageId));
      } catch (err) {
        alertLine(`Feedback not sent: ${err.message}`);
      }
    });
    row.append(b);
  }
  return row;
}

/**
 * Plain text with `code`, **bold** and links, built as nodes: agent text never becomes HTML.
 * Web links open in the browser; a file or folder on this PC opens in its app or in Explorer.
 */
function formatText(text) {
  return splitLinks(text).map((piece) => {
    if (piece.kind === "text") return document.createTextNode(piece.text);
    if (piece.kind === "code" || piece.kind === "bold") {
      const el = document.createElement(piece.kind === "code" ? "code" : "strong");
      el.textContent = piece.text;
      return el;
    }
    const a = document.createElement("a");
    a.textContent = piece.text;
    if (piece.kind === "url") {
      // The real link stays on the element (right-click, copy); a click goes to the hub, which
      // opens it in the PC's default browser instead of this Edge window.
      a.href = piece.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = `Open in your browser: ${piece.url}`;
      const open = async (event) => {
        if (event.type === "auxclick" && event.button !== 1) return;
        event.preventDefault();
        try {
          await api("/v1/open-url", { method: "POST", body: JSON.stringify({ url: piece.url }) });
        } catch {
          window.open(piece.url, "_blank", "noopener");
        }
      };
      a.addEventListener("click", open);
      a.addEventListener("auxclick", open);
      return a;
    }
    a.className = "path";
    a.href = "#";
    a.title = `Open ${piece.path}`;
    a.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        await api("/v1/open", { method: "POST", body: JSON.stringify({ path: piece.path }) });
      } catch (err) {
        alertLine(`Couldn't open it: ${err.message}`);
      }
    });
    return a;
  });
}

function renderApprovals(agent) {
  const box = $("approvals");
  const mine = state.approvals.filter((a) => a.agent === agent);
  box.replaceChildren(
    ...mine.map((a) => {
      const card = document.createElement("article");
      card.className = "approval";
      const h = document.createElement("h2");
      h.textContent = a.summary;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${a.code} · ${a.type}${a.why ? ` · ${a.why}` : ""}`;
      card.append(h, meta);
      const flags = [a.tainted ? "triggered by an email" : null, a.risk ? `risk: ${a.risk}` : null]
        .filter(Boolean)
        .join(" · ");
      if (flags) {
        const risk = document.createElement("div");
        risk.className = "risk";
        risk.textContent = flags;
        card.append(risk);
      }
      const dl = document.createElement("dl");
      for (const [k, v] of Object.entries(a.payload ?? {})) {
        if (k === "grant") continue;
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = String(v).slice(0, 600);
        dl.append(dt, dd);
      }
      card.append(dl);
      const actions = document.createElement("div");
      actions.className = "actions";
      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "approve";
      yes.textContent = "Approve";
      const no = document.createElement("button");
      no.type = "button";
      no.className = "deny";
      no.textContent = "Deny";
      const buttons = [yes, no];
      yes.addEventListener("click", () => decide(a.code, "approve", buttons));
      no.addEventListener("click", () => decide(a.code, "deny", buttons));
      // Follows and the like: yes to this one, or to all of them for the rest of the task.
      const grant = GRANT_LABELS[a.payload?.grant];
      if (grant) {
        yes.textContent = "Just this one";
        const all = document.createElement("button");
        all.type = "button";
        all.className = "approve";
        all.textContent = `Yes to all ${grant} in this task`;
        all.addEventListener("click", () => decide(a.code, "approve", buttons, "task"));
        buttons.push(all);
        actions.append(yes, all, no);
      } else {
        actions.append(yes, no);
      }
      card.append(actions);
      return card;
    }),
  );
}

// ---- actions

async function select(agent) {
  state.selected = agent;
  localStorage.setItem("crew-agent", agent);
  renderTeam();
  renderThread();
  await loadThread(agent);
  $("input").focus();
}

async function loadThread(agent) {
  try {
    const { messages } = await api(`/v1/threads/${agent}/messages?limit=100`);
    state.messages[agent] = messages;
    if (agent === state.selected) renderThread();
  } catch {
    /* the next event retries */
  }
}

async function refresh() {
  const [agents, approvals, budget] = await Promise.all([
    api("/v1/agents"),
    api("/v1/approvals?status=pending"),
    api("/v1/budget"),
  ]);
  state.agents = agents.agents;
  state.approvals = approvals.approvals;
  state.usage = budget.usage;
  state.limit = budget.limit ?? null;
  // The kill switch: paused holds every run; the button resumes.
  const pause = $("pause");
  pause.setAttribute("aria-pressed", String(Boolean(budget.paused)));
  pause.textContent = budget.paused ? "Resume" : "Pause all";
  pause.title = budget.paused
    ? "Everything is paused: click to let the agents work again"
    : "Stop every agent now and hold new work";
  $("phones-open").hidden = !budget.phones;
  renderTeam();
  renderThread();
}

/** "Tell it now": the note reaches the agent after the step it's on. */
async function sendNow() {
  const input = $("input");
  const text = input.value.trim();
  const agent = state.selected;
  if (!text || !agent || state.sending) return;
  state.sending = true;
  $("send-now").disabled = true;
  try {
    const answer = await api(`/v1/threads/${agent}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, now: true }),
    });
    input.value = "";
    autosize();
    state.messages[agent] = [...(state.messages[agent] ?? []), { role: "you", text }];
    renderThread();
    if (!answer.now) alertLine(`${titleOf(agent)} had already finished, so it's a new message.`);
  } catch (err) {
    alertLine(`Not sent: ${err.message}`);
  } finally {
    state.sending = false;
    $("send-now").disabled = false;
  }
}

async function send(event) {
  event.preventDefault();
  const input = $("input");
  const text = input.value.trim();
  const agent = state.selected;
  if (state.pending.some((p) => p.status === "uploading")) {
    alertLine("Still uploading: send again in a moment.");
    return;
  }
  const files = state.pending.filter((p) => p.status === "ready").map((p) => p.meta);
  if ((!text && !files.length) || !agent || state.sending) return;
  state.sending = true;
  $("send").disabled = true;
  try {
    await api(`/v1/threads/${agent}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, attachments: files.map((f) => f.id) }),
    });
    input.value = "";
    autosize();
    clearPending();
    state.messages[agent] = [
      ...(state.messages[agent] ?? []),
      { role: "you", text, attachments: files },
    ];
    renderThread();
    $("messages").scrollTop = $("messages").scrollHeight;
  } catch (err) {
    alertLine(`Not sent: ${err.message}`);
  } finally {
    state.sending = false;
    $("send").disabled = false;
  }
}

/** What a "yes to all" covers (core/gate.mjs GRANTS). */
const GRANT_LABELS = { follow: "follows and connects" };

async function decide(code, decision, buttons, scope = "once") {
  for (const b of buttons) b.disabled = true;
  try {
    await api(`/v1/approvals/${code}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, scope, nonce: crypto.randomUUID() }),
    });
    await refresh();
  } catch (err) {
    for (const b of buttons) b.disabled = false;
    alertLine(`${code}: ${err.message}`);
  }
}

async function freshStart() {
  const agent = state.selected;
  if (!agent) return;
  await api(`/v1/threads/${agent}/new`, { method: "POST" });
  alertLine(`${titleOf(agent)}'s next message starts a fresh session.`);
}

async function syncMemory() {
  const agent = state.selected;
  if (!agent) return;
  try {
    await api(`/v1/agents/${agent}/sync`, { method: "POST", body: "{}" });
    alertLine(
      `The CEO is giving ${titleOf(agent)} the memory it needs. You'll see it here when it's done.`,
    );
    refresh().catch(() => {});
  } catch (err) {
    alertLine(err.message);
  }
}

async function openTerminal() {
  const agent = state.selected;
  if (!agent) return;
  try {
    await api(`/v1/threads/${agent}/terminal`, { method: "POST", body: "{}" });
    alertLine(
      `Opened ${titleOf(agent)}'s conversation in a terminal. Crew waits while it is open.`,
    );
  } catch (err) {
    alertLine(err.message);
  }
}

function alertLine(text) {
  const agent = state.selected;
  if (!agent) return;
  state.messages[agent] = [...(state.messages[agent] ?? []), { role: "note", text }];
  renderThread();
}

// ---- new agents

/**
 * Fill an icon picker: 25 faces wearing each icon; the chosen one is outlined, and the big
 * face beside it previews it.
 */
function iconPicker(grid, preview, agent, chosen, onPick) {
  preview.dataset.face = agent;
  preview.dataset.mood = "smile";
  if (chosen) preview.dataset.icon = chosen;
  else delete preview.dataset.icon;
  delete preview.dataset.drawn;
  grid.replaceChildren(
    ...ICON_NAMES.map((icon) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icon-choice";
      b.title = CRITTERS[icon].label;
      b.setAttribute("aria-label", CRITTERS[icon].label);
      b.setAttribute("aria-pressed", String(icon === chosen));
      const face = document.createElement("span");
      face.className = "face";
      face.dataset.face = agent;
      face.dataset.icon = icon;
      face.dataset.mood = "smile";
      const name = document.createElement("span");
      name.textContent = CRITTERS[icon].label;
      b.append(face, name);
      b.addEventListener("click", () => {
        for (const other of grid.children) other.setAttribute("aria-pressed", "false");
        b.setAttribute("aria-pressed", "true");
        preview.dataset.icon = icon;
        delete preview.dataset.drawn;
        onPick(icon);
        paintFaces();
      });
      return b;
    }),
  );
  paintFaces();
}

// ---- skills: what the agent has learned (core/skills.mjs) and how its week went

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function stat(value, label, before) {
  const box = el("div", "stat");
  box.append(el("b", null, value), el("span", null, label));
  if (before != null) box.append(el("small", null, before));
  return box;
}

const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);

async function openSkills() {
  const agent = state.selected;
  if (!agent) return;
  $("skills-title").textContent = `${titleOf(agent)}'s skills`;
  $("skills-lead").textContent = "Loading…";
  $("skills-score").replaceChildren();
  $("skills-trend").textContent = "";
  $("skills-list").replaceChildren();
  $("skills").showModal();
  let data;
  try {
    data = await api(`/v1/agents/${agent}/skills`);
  } catch (err) {
    $("skills-lead").textContent = err.message;
    return;
  }
  const { skills, score } = data;
  const w = score.week;
  const b = score.before;
  $("skills-lead").textContent =
    "Work it does twice becomes a skill, and every run improves it. Last 7 days, with the 7 before:";
  $("skills-score").replaceChildren(
    stat(String(w.realTasks), "real tasks", `before: ${b.realTasks}`),
    stat(pct(w.skillShare), "done with a skill", `before: ${pct(b.skillShare)}`),
    stat(String(w.corrections), "corrections", `before: ${b.corrections}`),
    stat(String(score.skills.skills), "skills", `improved ${score.skills.improvements}×`),
  );
  const t =
    w.correctionsPerTask == null || b.correctionsPerTask == null
      ? null
      : w.correctionsPerTask < b.correctionsPerTask
        ? "better"
        : w.correctionsPerTask > b.correctionsPerTask
          ? "worse"
          : "same";
  const trendText = {
    better: "Fewer corrections per task than the week before.",
    worse: "More corrections per task than the week before.",
    same: "About the same as the week before.",
  };
  $("skills-trend").className = `score-trend ${t ?? ""}`;
  $("skills-trend").textContent = t
    ? `${trendText[t]} Corrections are thumbs down, quick OKs you said no to, and failed runs.`
    : "Corrections are thumbs down, quick OKs you said no to, and failed runs.";

  paintChecks(agent).catch(() => {});
  if (!skills.length) {
    $("skills-list").append(
      el(
        "li",
        "faint",
        "No skills yet. After its next real task it writes down how it did it; the second time, that becomes a skill.",
      ),
    );
    return;
  }
  for (const k of skills) {
    const item = el("li", "skill");
    const head = el("div", "skill-head");
    head.append(
      el("span", "skill-name", k.name),
      el(
        "span",
        `skill-chip ${k.stage}`,
        k.stage === "skill" ? `v${k.version}` : k.playbook ? "playbook" : "written down once",
      ),
    );
    item.append(head);
    if (k.description) item.append(el("p", "skill-desc", k.description));
    if (k.changes?.length) {
      const list = el("ul", "skill-changes");
      for (const c of k.changes) list.append(el("li", null, c));
      item.append(list);
    }
    $("skills-list").append(item);
  }
}

const whenLabel = (ms) =>
  new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** The checks the agent scheduled for itself, open ones first, each with Cancel. */
async function paintChecks(agent) {
  const { checks } = await api(`/v1/checks?agent=${agent}`);
  const list = $("checks-list");
  list.replaceChildren();
  if (!checks.length) {
    list.append(
      el(
        "li",
        "faint",
        "None. It schedules its own when something needs a look later (a booking, a reply it's waiting on, how a post did).",
      ),
    );
    return;
  }
  for (const c of checks.slice(0, 12)) {
    const open = c.status === "active";
    const item = el("li", `skill${open ? "" : " closed"}`);
    const row = el("div", "check-row");
    const body = el("div");
    const when = open
      ? `Next: ${whenLabel(c.at)}${c.every ? ` · every ${Math.round(c.every / 3_600_000)}h until ${whenLabel(c.until)}` : ""}`
      : `${c.status === "cancelled" ? "Cancelled" : "Done"} · ran ${c.runs}×`;
    body.append(el("span", "check-when", when), el("p", "skill-desc", c.why || c.what));
    row.append(body);
    if (open) {
      const cancel = el("button", "ghost", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        await api(`/v1/checks/${c.id}/cancel`, { method: "POST", body: "{}" }).catch(() => {});
        paintChecks(agent).catch(() => {});
      });
      row.append(cancel);
    }
    item.append(row);
    list.append(item);
  }
}

// ---- agent profile: rename, change icon

const profile = { agent: null, icon: null };

function openProfile() {
  const agent = state.selected;
  if (!agent) return;
  const me = state.agents.find((a) => a.id === agent);
  profile.agent = agent;
  // The icon it wears now: the one picked, or its own default.
  profile.icon = me?.icon ?? iconFor(agent);
  $("profile-name").value = titleOf(agent);
  $("profile-was").textContent = "Only the name on screen changes. It'll be told its new name.";
  $("profile-note").textContent = "";
  iconPicker($("profile-icons"), $("profile-face"), agent, profile.icon, (icon) => {
    profile.icon = icon;
  });
  $("profile").showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  const agent = profile.agent;
  const title = $("profile-name").value.trim();
  const body = {};
  if (title && title !== titleOf(agent)) body.title = title;
  const wearing = state.agents.find((a) => a.id === agent)?.icon ?? iconFor(agent);
  if (profile.icon && profile.icon !== wearing) {
    body.icon = profile.icon;
  }
  if (!Object.keys(body).length) return $("profile").close();
  $("profile-save").disabled = true;
  try {
    await api(`/v1/agents/${agent}/profile`, { method: "POST", body: JSON.stringify(body) });
    $("profile").close();
    await refresh();
  } catch (err) {
    $("profile-note").textContent = err.message;
  } finally {
    $("profile-save").disabled = false;
  }
}

// ---- new agents

const draft = { icon: null };

function openNewAgent() {
  $("new-agent-name").value = "";
  $("new-agent-brief").value = "";
  $("new-agent-note").textContent = "";
  draft.icon = null;
  iconPicker($("new-agent-icons"), $("new-agent-face"), "newagent", null, (icon) => {
    draft.icon = icon;
  });
  $("new-agent").showModal();
  $("new-agent-name").focus();
}

async function askForAgent(event) {
  event.preventDefault();
  const brief = $("new-agent-brief").value.trim();
  if (!brief) return;
  const title = $("new-agent-name").value.trim();
  $("new-agent-go").disabled = true;
  try {
    await api("/v1/agents/new", {
      method: "POST",
      body: JSON.stringify({ brief, title: title || undefined, icon: draft.icon ?? undefined }),
    });
    $("new-agent").close();
    // The CEO drafts it in its own chat, then asks for approval there.
    select("ceo");
  } catch (err) {
    $("new-agent-note").textContent = `Not sent: ${err.message}`;
  } finally {
    $("new-agent-go").disabled = false;
  }
}

// ---- phones

async function openPhones() {
  $("pairing").hidden = true;
  $("phones").showModal();
  await renderPhones();
}

async function renderPhones() {
  const { devices } = await api("/v1/devices");
  const live = devices.filter((d) => !d.revoked);
  const list = $("phone-list");
  if (!live.length) {
    const li = document.createElement("li");
    li.className = "faint";
    li.textContent = "No phones paired yet.";
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...live.map((d) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = d.name;
      const meta = document.createElement("span");
      meta.className = "faint";
      const seen = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "never";
      meta.textContent = ` · ${d.push ? "notifications on" : "no notifications"} · seen ${seen}`;
      text.append(name, meta);
      const cut = document.createElement("button");
      cut.type = "button";
      cut.className = "ghost small";
      cut.textContent = "Cut off";
      cut.addEventListener("click", async () => {
        if (!confirm(`Cut off ${d.name}? It will need pairing again.`)) return;
        await api(`/v1/devices/${d.id}/revoke`, { method: "POST" });
        await renderPhones();
      });
      li.append(text, cut);
      return li;
    }),
  );
}

async function startPairing() {
  const { code, expiresAt, hubUrl } = await api("/v1/pair/start", { method: "POST" });
  $("pair-hub").textContent = hubUrl ?? "Tailscale isn't running on this PC";
  $("pair-code").textContent = `${code.slice(0, 4)} ${code.slice(4)}`;
  $("pair-expiry").textContent =
    `Works once, until ${new Date(expiresAt).toLocaleTimeString()}. This list updates when the phone pairs.`;
  $("pairing").hidden = false;
}

function autosize() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  // A scroll bar only once the text outgrows the box.
  input.style.overflowY = input.scrollHeight > 180 ? "auto" : "hidden";
}

// ---- live updates: server-sent events over fetch, so the key stays in a header

async function listen() {
  for (;;) {
    const abort = new AbortController();
    // The hub pings every 15 s: 40 s of silence means the connection died quietly.
    let watchdog = setTimeout(() => abort.abort(), 40_000);
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => abort.abort(), 40_000);
    };
    try {
      const res = await fetch(`/v1/events?since=${state.seq}&window=1`, {
        headers: { authorization: `Bearer ${state.token}` },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      setHub(true);
      await refresh();
      if (state.selected) loadThread(state.selected);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        alive();
        buffer += value;
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block
            .split("\n")
            .find((l) => l.startsWith("data: "))
            ?.slice(6);
          if (data) onEvent(JSON.parse(data));
        }
      }
    } catch {
      setHub(false);
    } finally {
      clearTimeout(watchdog);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Bursts of events (agents working side by side emit many) become one refresh at most every
 * 200 ms. The timer is never pushed back, so a busy agent can't hold the window still, and
 * every agent touched in the burst is remembered, not just the last one.
 */
let refreshTimer = null;
const touched = new Set();
function onEvent(e) {
  state.seq = Math.max(state.seq, e.seq);
  if (e.type?.startsWith("device.") && $("phones").open) {
    if (e.type === "device.paired") $("pairing").hidden = true;
    renderPhones().catch(() => {});
  }
  // `crew open <agent>` (or a click on claude-face) asks this window to show an agent.
  if (
    e.type === "window.show" &&
    e.data?.agent &&
    state.agents.some((a) => a.id === e.data.agent)
  ) {
    select(e.data.agent);
  }
  if (e.type === "face.changed") loadFace();
  if (e.type === "notify") alertLine(`${e.data.title}: ${e.data.body}`);
  if (e.data?.agent) touched.add(e.data.agent);
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh().catch(() => {});
    if (state.selected && touched.has(state.selected)) loadThread(state.selected);
    touched.clear();
  }, 200);
}

/** Coming back to the window (or every 30 s while it is open): catch anything missed. */
function catchUp() {
  if (!state.token || $("locked").hidden === false) return;
  refresh().catch(() => {});
  if (state.selected) loadThread(state.selected);
}
window.addEventListener("focus", catchUp);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) catchUp();
});
setInterval(() => {
  if (!document.hidden) catchUp();
}, 30_000);

function setHub(up) {
  const el = $("hub-state");
  el.textContent = up ? "Connected" : "Crew isn't running. Open it from the Crew icon.";
  el.classList.toggle("down", !up);
}

// ---- attachments

const PAPERCLIP =
  "M20.5 11.5l-8.2 8.2a5.3 5.3 0 01-7.5-7.5l8.6-8.6a3.5 3.5 0 015 5l-8.6 8.6a1.8 1.8 0 01-2.5-2.5l8-8";
const sizeText = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const isImage = (type) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type);

/** Upload files as soon as they are picked, dropped or pasted; they go with the next send. */
function addFiles(list) {
  for (const file of list) {
    if (state.pending.length >= 10) {
      alertLine("At most 10 files on one message.");
      break;
    }
    if (file.size > 25 * 1024 * 1024) {
      alertLine(`${file.name} is over 25 MB.`);
      continue;
    }
    const item = {
      key: crypto.randomUUID(),
      file,
      status: "uploading",
      meta: null,
      preview: isImage(file.type) ? URL.createObjectURL(file) : null,
    };
    state.pending.push(item);
    upload(item);
  }
  renderTray();
}

async function upload(item) {
  try {
    const res = await fetch("/v1/attachments", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.token}`,
        "content-type": item.file.type || "application/octet-stream",
        "x-filename": encodeURIComponent(item.file.name || "file"),
      },
      body: item.file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    item.meta = body.attachment;
    item.status = "ready";
  } catch (err) {
    state.pending = state.pending.filter((p) => p !== item);
    if (item.preview) URL.revokeObjectURL(item.preview);
    alertLine(`${item.file.name} not attached: ${err.message}`);
  }
  renderTray();
}

function clearPending() {
  for (const p of state.pending) if (p.preview) URL.revokeObjectURL(p.preview);
  state.pending = [];
  renderTray();
}

function renderTray() {
  const tray = $("tray");
  tray.hidden = !state.pending.length;
  tray.replaceChildren(
    ...state.pending.map((p) => {
      const li = document.createElement("li");
      li.className = `chip${p.status === "uploading" ? " busy" : ""}`;
      if (p.preview) {
        const img = document.createElement("img");
        img.src = p.preview;
        img.alt = "";
        li.append(img);
      } else li.append(lineIcon(PAPERCLIP));
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.file.name;
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = p.status === "uploading" ? "uploading…" : sizeText(p.file.size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${p.file.name}`);
      remove.addEventListener("click", () => {
        state.pending = state.pending.filter((x) => x !== p);
        if (p.preview) URL.revokeObjectURL(p.preview);
        renderTray();
      });
      li.append(name, size, remove);
      return li;
    }),
  );
}

/** Images fetched with the key, kept as blob URLs while the window is open. */
const imageUrls = new Map();
function attachmentImage(meta) {
  const img = document.createElement("img");
  img.alt = meta.name;
  img.title = `${meta.name} · click to open on this PC`;
  const known = imageUrls.get(meta.id);
  if (known) img.src = known;
  else {
    fetch(`/v1/attachments/${meta.id}`, { headers: { authorization: `Bearer ${state.token}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        imageUrls.set(meta.id, url);
        img.src = url;
        // The picture makes the message taller: keep a chat that was at the bottom there.
        img.addEventListener("load", () => {
          const list = $("messages");
          if (list.scrollHeight - list.scrollTop - list.clientHeight < img.height + 80) {
            list.scrollTop = list.scrollHeight;
          }
        });
      })
      .catch(() => (img.alt = `${meta.name} (not found)`));
  }
  img.addEventListener("click", () => openOnPc(meta.path));
  return img;
}

function attachmentList(files) {
  const box = document.createElement("div");
  box.className = "files";
  for (const meta of files) {
    if (meta.kind === "image") {
      box.append(attachmentImage(meta));
      continue;
    }
    const a = document.createElement("a");
    a.className = "chip";
    a.href = "#";
    a.title = `Open ${meta.path}`;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = meta.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = sizeText(meta.size);
    a.append(lineIcon(PAPERCLIP), name, size);
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openOnPc(meta.path);
    });
    box.append(a);
  }
  return box;
}

async function openOnPc(path) {
  try {
    await api("/v1/open", { method: "POST", body: JSON.stringify({ path }) });
  } catch (err) {
    alertLine(`Couldn't open it: ${err.message}`);
  }
}

// ---- claude-face

async function loadFace() {
  try {
    showFace(await api("/v1/face"));
  } catch {
    /* the hub is older or down: leave the button hidden */
  }
}

function showFace(status) {
  const b = $("face-toggle");
  b.hidden = !status.installed;
  b.setAttribute("aria-pressed", String(Boolean(status.on)));
  $("face-label").textContent = status.on ? "Face on" : "Face off";
  b.title = status.on
    ? "claude-face is on: click to turn it off"
    : "claude-face is off: click to turn it on";
}

async function toggleFace() {
  const b = $("face-toggle");
  const on = b.getAttribute("aria-pressed") !== "true";
  b.disabled = true;
  try {
    showFace(await api("/v1/face", { method: "POST", body: JSON.stringify({ on }) }));
    alertLine(on ? "claude-face is on." : "claude-face is off. It won't start with Windows.");
  } catch (err) {
    alertLine(`claude-face: ${err.message}`);
  } finally {
    b.disabled = false;
  }
}

// ---- start

async function start() {
  state.token = await takeToken();
  if (!state.token) {
    showLocked();
    return;
  }
  $("composer").addEventListener("submit", send);
  $("fresh").addEventListener("click", () => freshStart().catch(() => {}));
  $("terminal").addEventListener("click", () => openTerminal().catch(() => {}));
  $("sync-memory").addEventListener("click", () => syncMemory().catch(() => {}));
  $("phones-open").addEventListener("click", () => openPhones().catch(() => {}));
  $("new-agent-open").addEventListener("click", openNewAgent);
  $("new-agent-form").addEventListener("submit", (e) => askForAgent(e).catch(() => {}));
  $("new-agent-close").addEventListener("click", () => $("new-agent").close());
  $("profile-open").addEventListener("click", openProfile);
  $("skills-open").addEventListener("click", () => openSkills().catch(() => {}));
  $("skills-close").addEventListener("click", () => $("skills").close());
  $("profile-form").addEventListener("submit", (e) => saveProfile(e).catch(() => {}));
  $("profile-close").addEventListener("click", () => $("profile").close());
  $("profile-cancel").addEventListener("click", () => $("profile").close());
  $("find").addEventListener("input", renderTeam);
  $("phones-close").addEventListener("click", () => $("phones").close());
  $("pair-start").addEventListener("click", () => startPairing().catch(() => {}));
  $("input").addEventListener("input", autosize);
  $("attach").addEventListener("click", () => $("file-input").click());
  $("face-toggle").addEventListener("click", () => toggleFace());
  $("pause").addEventListener("click", async () => {
    const paused = $("pause").getAttribute("aria-pressed") === "true";
    try {
      await api(paused ? "/v1/resume-all" : "/v1/stop-all", { method: "POST", body: "{}" });
      alertLine(
        paused
          ? "The agents are working again."
          : "Everything is paused. Nothing runs until you resume.",
      );
      await refresh();
    } catch (err) {
      alertLine(`Couldn't ${paused ? "resume" : "pause"}: ${err.message}`);
    }
  });
  loadFace();
  $("file-input").addEventListener("change", (e) => {
    addFiles([...e.target.files]);
    e.target.value = "";
  });
  $("input").addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  const thread = $("thread");
  thread.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
    e.preventDefault();
    $("composer").classList.add("dropping");
  });
  thread.addEventListener("dragleave", (e) => {
    if (!thread.contains(e.relatedTarget)) $("composer").classList.remove("dropping");
  });
  thread.addEventListener("drop", (e) => {
    e.preventDefault();
    $("composer").classList.remove("dropping");
    addFiles([...(e.dataTransfer?.files ?? [])]);
  });
  $("send-now").addEventListener("click", () => sendNow().catch(() => {}));
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      sendNow().catch(() => {});
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  document.addEventListener("keydown", (e) => {
    // Number keys pick an agent, but not while typing or with a dialog open.
    if (["TEXTAREA", "INPUT"].includes(e.target.tagName)) return;
    if (document.querySelector("dialog[open]")) return;
    const n = Number(e.key);
    if (n >= 1 && n <= state.agents.length) select(state.agents[n - 1].id);
  });

  const remembered = localStorage.getItem("crew-agent");
  if (remembered) state.selected = remembered;
  listen();
  if (state.selected) loadThread(state.selected);
}

// A new `crew open` link into an already-open window only changes the hash: start over with it.
window.addEventListener("hashchange", () => location.reload());

start();

// Edge reopens an app window at its remembered size, which can run past the bottom of the
// screen and hide the message box. Pull it back on screen. (Only app windows may resize.)
function fitScreen() {
  const { availWidth, availHeight, availLeft = 0, availTop = 0 } = screen;
  if (window.outerHeight <= availHeight && window.outerWidth <= availWidth) return;
  const width = Math.min(window.outerWidth, availWidth - 40);
  const height = Math.min(window.outerHeight, availHeight - 40);
  window.moveTo(availLeft + 20, availTop + 20);
  window.resizeTo(width, height);
}
fitScreen();
