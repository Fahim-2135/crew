// The hub: the one owner of every agent run. It queues jobs, runs them side by side (headless
// Claude Code turns in each agent's ongoing thread, or brain scripts such as the mailroom),
// wakes agents on schedules and new inbox items, keeps the usage budget and quiet hours, and
// records everything as events for the CLI, the mod and the app.

import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { crewNote, buildArgs, runSettings } from "./core/policy.mjs";
import { admit, halfRate, PRIORITY } from "./core/budget.mjs";
import { rotationReason, handover } from "./core/rotation.mjs";
import { blockedBy, dueSchedules, localParts, startOfLocalDay } from "./core/schedule.mjs";
import { isOpen, wakePrompt } from "./core/inbox.mjs";
import { buildReport } from "./core/report.mjs";
import { DEFAULT_CONFIG, SYSTEM_SCRIPTS } from "./core/config.mjs";
import {
  ACTIONS,
  approvalCode,
  decide,
  expired,
  needReminder,
  outcomeMessage,
  validateRequest,
} from "./core/approvals.mjs";
import { inspectCommand } from "./core/safety.mjs";
import { pushFor } from "./core/push.mjs";
import { terminalTurns } from "./core/transcript.mjs";
import { MAX_PER_MESSAGE, attachmentNote, kindOf } from "./core/attachments.mjs";
import { REPLY_LIMIT, askBlocked, askPrompt, replyPrompt, teamLines } from "./core/teamtalk.mjs";
import { GRANTS } from "./core/gate.mjs";
import { ICON_NAMES } from "../../shared/faces.mjs";
import { createSplitter, voiceNote } from "./core/speech.mjs";
import { owner, Owner, setOwner } from "./core/owner.mjs";

/** How long a run may take before it is stopped. */
/** A chat or routine may run long (and wait on a quick OK); a call answers fast or calls back. */
export const TIMEOUTS = Object.freeze({ chat: 45 * 60_000, call: 4 * 60_000 });

/** How long a finished job keeps its agent's face green. */
const DONE_FOR_MS = 15 * 60_000;

/** Text Claude Code prints when it cannot resume a session it does not know. */
const LOST_SESSION = /no conversation found|session.*not found/i;
const LIMIT_TEXT = /usage limit|rate limit|429|limit reached/i;
/** Text Claude Code prints when asked to create a session id that already exists. */
const SESSION_IN_USE = /session id .* is already in use/i;

export class Hub extends EventEmitter {
  /**
   * @param {{
   *   store: import("./io/store.mjs").Store,
   *   paths: { brain: string, agentsDir: string, runs: string, crewGuard: string,
   *     mcpServer?: string, port?: number, token?: string },
   *   execute?: typeof import("./io/executors.mjs").execute,
   *   capturePreconditions?: typeof import("./io/executors.mjs").capturePreconditions,
   *   random?: () => number,
   *   bin: string,
   *   runTurn: typeof import("./io/claude.mjs").runTurn,
   *   runScript?: typeof import("./io/claude.mjs").runScript,
   *   sessions: (bin: string) => Array<{ sessionId: string, kind: string, status: string }>,
   *   scanInboxes?: (brain: string, departments: string[]) => object[],
   *   killTree?: (pid: number) => void,
   *   afterWrite?: () => void,
   *   config?: typeof DEFAULT_CONFIG,
   *   now?: () => number,
   *   utcOffsetMinutes?: () => number,
   *   nodeBin?: string,
   *   push?: ((pushToken: string, message: object) => Promise<{ ok: boolean,
   *     unregistered?: boolean, error?: string }>) | null,
   * }} deps
   */
  constructor(deps) {
    super();
    this.store = deps.store;
    this.paths = deps.paths;
    this.bin = deps.bin;
    this.runTurnFn = deps.runTurn;
    this.runScriptFn = deps.runScript ?? null;
    this.sessionsFn = deps.sessions;
    this.scanInboxesFn = deps.scanInboxes ?? (() => []);
    this.killTreeFn = deps.killTree ?? (() => {});
    this.afterWrite = deps.afterWrite ?? (() => {});
    this.config = deps.config ?? DEFAULT_CONFIG;
    setOwner(this.config.owner);
    this.now = deps.now ?? (() => Date.now());
    this.offset = deps.utcOffsetMinutes ?? (() => -new Date().getTimezoneOffset());
    this.nodeBin = deps.nodeBin ?? process.execPath.replace(/\\/g, "/");
    this.executeFn = deps.execute ?? null;
    this.captureFn = deps.capturePreconditions ?? (() => ({}));
    this.random = deps.random ?? Math.random;
    /** Folders a run may work in besides the brain: every drive, by default (start.mjs). */
    this.workDirs = deps.workDirs ?? [];
    this.pushFn = deps.push ?? null;
    this.createAgentFn = deps.createAgent ?? null;
    this.updateAgentFn = deps.updateAgent ?? null;
    this.openTerminalFn = deps.openTerminal ?? null;
    this.openPathFn = deps.openPath ?? null;
    this.readPreviewFn = deps.readPreview ?? null;
    this.openUrlFn = deps.openUrl ?? null;
    /** claude-face on this PC: { status(), set(on) } (io/face.mjs). */
    this.faceFns = deps.face ?? null;
    /** Desktop notifications (io/notify.mjs), for people without the phone app. */
    this.notifyFn = deps.notify ?? null;
    this.readTranscriptFn = deps.readTranscript ?? null;
    this.definitionHashFn = deps.definitionHash ?? (() => null);
    /** The pairing code on screen, if any: { code, expiresAt, failures }. In memory only. */
    this.pairing = null;
    /**
     * The runs in progress, by job id. Agents work side by side, one run per agent at a time.
     * @type {Map<number, { agent: string, kind: string, kill: () => void }>}
     */
    this.running = new Map();
    /** Questions in flight (ask_teammate): ask job id -> { from, fromJob, to }. */
    this.asks = new Map();
    /** "Yes to all of these for this task": job id -> kinds (core/gate.mjs GRANTS). */
    this.grants = new Map();
    /** Their promises, so shutdown can wait for every one to record how it ended. */
    this.current = new Set();
    this.stopped = false;
    this.cancelling = new Set();
    this.retryTimer = null;
  }

  /** Recover from a crash (a job left "running" never finished), then start working. */
  start() {
    for (const job of this.store.jobsWithStatus("running")) {
      if (job.pid) this.killTreeFn(job.pid);
      this.store.updateJob(job.id, {
        status: "failed",
        endedAt: this.now(),
        error: "hub restarted",
      });
      this.event("job.failed", { jobId: job.id, agent: job.agent, error: "hub restarted" });
    }
    this.tick();
  }

  /** Stop starting new work and kill every run in progress. */
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.killAll();
  }

  killAll() {
    for (const [jobId, run] of this.running) {
      this.cancelling.add(jobId);
      run.kill();
    }
  }

  /** The run in progress for an agent, if any. */
  runningFor(agent) {
    for (const [jobId, run] of this.running) if (run.agent === agent) return { jobId, ...run };
    return null;
  }

  /** stop(), then wait until every run in progress has recorded how it ended. */
  async shutdown() {
    this.stop();
    await Promise.all([...this.current]);
  }

  // --- the team: the first eight, plus the agents the user has created

  /** Agents created through Crew, oldest first: { id, title, createdAt }. */
  custom() {
    return this.store.get("team:custom", []);
  }

  customIds() {
    return this.custom().map((a) => a.id);
  }

  team() {
    return [...this.config.team.map((a) => a.id), ...this.customIds()];
  }

  /** What Claude Code calls an agent: its id with config.agentPrefix (crew-ceo). */
  agentName(id) {
    return `${this.config.agentPrefix ?? ""}${id}`;
  }

  titleOf(id) {
    return (
      this.store.get("profiles", {})[id]?.title ??
      this.config.team.find((a) => a.id === id)?.title ??
      this.custom().find((a) => a.id === id)?.title ??
      id
    );
  }

  assertAgent(agent) {
    if (!this.team().includes(agent)) throw new HubError(404, `no agent named ${agent}`);
  }

  /**
   * The user wants a new agent: the CEO drafts it and asks for approval (agent.create). Nothing is
   * created until they approve the exact definition.
   */
  draftAgent(brief, origin = "pc", choice = {}) {
    const want = String(brief ?? "").trim();
    if (!want) throw new HubError(400, "say what the new agent should do");
    if (want.length > 2000) throw new HubError(400, "keep the brief under 2000 characters");
    const name = String(choice.title ?? "")
      .trim()
      .slice(0, 24);
    const icon = ICON_NAMES.includes(choice.icon) ? choice.icon : null;
    const prompt = [
      `${Owner()} wants a new agent on the team. Their words:`,
      "",
      want,
      "",
      name ? `They named it "${name}": use that exact title.` : "Pick a short title for it.",
      icon
        ? `They picked its icon: icon ${icon}.`
        : `Pick its icon from: ${ICON_NAMES.join(", ")} (or auto).`,
      `The team today: ${this.team()
        .map((id) => `${id} (${this.titleOf(id)})`)
        .join(", ")}. If an existing department already covers this, tell them which one and stop.`,
      "Otherwise draft the new agent and call request_approval with type agent.create. Payload: id (3-20 lowercase letters and digits), title (the name on screen), description (one or two sentences: what it does and when to use it), instructions (its standing instructions in second person: role, what it owns, which sources it reads, how it reports; under 6000 characters), web (yes or no), icon. Summary: one line naming the agent. Why: one sentence.",
      `Like every agent it gets the full toolset (files, the shell, the web, apps, the screen); inside the brain it writes only in its own folder and other agents' inboxes, and anything that can't be undone asks ${owner()} for a quick OK. Do not create any files yourself; Crew creates them once they approve.`,
    ].join("\n");
    return this.send("ceo", prompt, {
      origin,
      kind: "chat",
      shown: `New agent${name ? ` "${name}"` : ""}: ${want}`,
    });
  }

  /** The icon an agent wears in Crew: the one the user picked, if any (faces.mjs has the rest). */
  iconOf(id) {
    return (
      this.store.get("profiles", {})[id]?.icon ??
      this.custom().find((a) => a.id === id)?.icon ??
      null
    );
  }

  /**
   * Rename an agent or change its icon. Only its name on screen changes (its id, files and
   * memory stay); the agent is told its new name so it answers to it.
   * @param {string} agent
   * @param {{ title?: string, icon?: string }} input
   */
  setProfile(agent, input = {}) {
    this.assertAgent(agent);
    const profiles = this.store.get("profiles", {});
    const mine = { ...(profiles[agent] ?? {}) };
    const before = this.titleOf(agent);
    if (input.title !== undefined) {
      const title = String(input.title).trim().replace(/\s+/g, " ");
      if (!title || title.length > 24) throw new HubError(400, "a name of 1-24 characters");
      mine.title = title;
    }
    if (input.icon !== undefined) {
      if (!ICON_NAMES.includes(input.icon)) throw new HubError(400, "not one of the 25 icons");
      mine.icon = input.icon;
    }
    this.store.set("profiles", { ...profiles, [agent]: mine });
    const after = this.titleOf(agent);
    if (after !== before) {
      this.notify(
        agent,
        `Crew: ${Owner()} renamed you in Crew. You are now "${after}" (you were "${before}"). Answer to that name; nothing else about you changed.`,
      );
    }
    this.event("team.changed", { profile: agent });
    return { title: after, icon: this.iconOf(agent) };
  }

  /** Carry out an approved agent.create: the files, then the team list. */
  createAgent(payload) {
    if (!this.createAgentFn) return { status: "failed", result: "no agent creator configured" };
    if (this.team().includes(payload.id)) {
      return { status: "stale", result: `${payload.id} is already on the team` };
    }
    const outcome = this.createAgentFn(payload, {
      brainDir: this.paths.brain,
      agentsDir: this.paths.agentsDir,
      prefix: this.config.agentPrefix ?? "",
      today: localParts(this.now(), this.offset()).date,
    });
    if (outcome.status === "executed") {
      this.store.set("team:custom", [
        ...this.custom(),
        {
          id: payload.id,
          title: payload.title,
          description: payload.description,
          icon: ICON_NAMES.includes(payload.icon) ? payload.icon : null,
          createdAt: this.now(),
          memory: "unsynced",
        },
      ]);
      this.event("team.changed", { added: payload.id, title: payload.title });
      this.afterWrite({
        agent: payload.id,
        jobId: 0,
        kind: "agent.create",
        files: outcome.files ?? [],
      });
    }
    return outcome;
  }

  /** Carry out an approved agent.update: new instructions, same tools and scope. */
  updateAgent(approval) {
    if (!this.updateAgentFn) return { status: "failed", result: "no agent updater configured" };
    const outcome = this.updateAgentFn(approval.payload, {
      brainDir: this.paths.brain,
      agentsDir: this.paths.agentsDir,
      prefix: this.config.agentPrefix ?? "",
      today: localParts(this.now(), this.offset()).date,
      expectHash: approval.preconditions?.definition ?? null,
    });
    if (outcome.status === "executed") {
      this.event("team.changed", { updated: approval.payload.id });
      this.afterWrite({
        agent: approval.payload.id,
        jobId: 0,
        kind: "agent.update",
        files: outcome.files ?? [],
      });
    }
    return outcome;
  }

  // --- giving a new agent the memory it needs

  /** For agents the user created: { created: true, memory: unsynced | syncing | synced }. */
  memoryState(id) {
    const me = this.custom().find((a) => a.id === id);
    return me ? { created: true, memory: me.memory ?? "unsynced" } : {};
  }

  setCustom(id, fields) {
    this.store.set(
      "team:custom",
      this.custom().map((a) => (a.id === id ? { ...a, ...fields } : a)),
    );
  }

  /**
   * "Sync memory" on a new agent: the CEO searches the brain for what this agent needs, writes
   * it into the agent's own memory as notes that point back at their sources, and adds a
   * "where to look" guide to its MEMORY.md. Done once, after creation, so creating an agent
   * stays quick.
   */
  syncMemory(agent, origin = "pc") {
    const me = this.custom().find((a) => a.id === agent);
    if (!me) throw new HubError(404, "only agents created through Crew need a memory sync");
    if (me.memory === "syncing") return { job: this.job(me.syncJob) };
    const slashes = (p) => String(p).replace(/\\/g, "/");
    const brain = slashes(this.paths.brain);
    const dir = brain + "/departments/" + agent + "/memory";
    const prompt = [
      "Memory sync for the new agent " + me.title + " (" + agent + "): " + (me.description ?? ""),
      "Its standing instructions: " +
        slashes(this.paths.agentsDir) +
        "/" +
        this.agentName(agent) +
        ".md.",
      "",
      "1. Search the brain for what it needs to do its job well: department memories, sources, lessons, people, areas, decisions and MAP.md.",
      "2. Write what it needs into " +
        dir +
        "/ as notes, one item per note named " +
        agent +
        "--<slug>.md, following the brain's AGENTS.md (front matter, absolute dates). Summarise in your own words and end each with a Source: line naming the original note. Never copy anything from private/ or coder/, and never write secrets.",
      "3. In " +
        dir +
        "/MEMORY.md, list each note in one line, and add a 'Where to look' section naming the brain folders and notes it should read for more (it can read everything except private/ and coder/).",
      `Then tell ${owner()} in two or three lines what you gave it and where it will look.`,
    ].join("\n");
    const job = this.send("ceo", prompt, {
      origin,
      kind: "chat",
      shown: "Sync memory for " + me.title,
    });
    this.setCustom(agent, { memory: "syncing", syncJob: job.id });
    this.event("team.changed", { syncing: agent });
    return { job };
  }

  memorySyncFinished(job, status) {
    const me = this.custom().find((a) => a.syncJob === job.id);
    if (!me) return;
    this.setCustom(me.id, { memory: status === "done" ? "synced" : "unsynced", syncJob: null });
    this.event("team.changed", { synced: me.id, ok: status === "done" });
  }

  // --- learning from the user's feedback

  /**
   * A thumbs up or down on one of an agent's replies. A thumbs down queues a short learning
   * review for that agent (one at a time): it may save a playbook in its own folder, or
   * propose a change to its own instructions for the user to approve.
   * @param {string} agent
   * @param {{ messageId?: number, rating: string, note?: string }} input
   */
  feedback(agent, input) {
    this.assertAgent(agent);
    const rating = input?.rating === "up" ? "up" : input?.rating === "down" ? "down" : null;
    if (!rating) throw new HubError(400, "rating must be up or down");
    const note = String(input.note ?? "")
      .trim()
      .slice(0, 500);
    const reply = this.store
      .messages(agent, 200)
      .find((m) => m.id === Number(input.messageId) && m.role === "agent");
    const item = {
      rating,
      note,
      reply: reply ? oneLine(reply.text, 400) : null,
      at: this.now(),
    };
    const key = "feedback:" + agent;
    this.store.set(key, [...this.store.get(key, []), item].slice(-20));
    this.event("feedback", { agent, rating });
    let review = null;
    if (rating === "down") {
      const pending = this.store
        .queuedJobs()
        .concat(this.store.jobsWithStatus("running"))
        .some((j) => j.agent === agent && j.kind === "learn");
      if (!pending) review = this.learn(agent);
    }
    return { ok: true, review: review ? review.id : null };
  }

  /** Queue a learning review with the feedback gathered so far, which it then clears. */
  learn(agent) {
    const key = "feedback:" + agent;
    const items = this.store.get(key, []);
    if (!items.length) return null;
    this.store.set(key, []);
    const lines = items.map((f) => {
      const mark = f.rating === "up" ? "Liked" : "Not right";
      const about = f.reply ? ' on your reply: "' + f.reply + '"' : "";
      return "- " + mark + about + (f.note ? ` ${Owner()}'s note: ` + f.note : "");
    });
    const prompt = [
      `Crew learning review. ${Owner()} gave feedback on your recent replies:`,
      "",
      ...lines,
      "",
      "1. If there is a lesson you will need again, save it now as a short playbook or memory note in your own department folder.",
      "2. If your standing instructions themselves should change (your file is " +
        this.paths.agentsDir.replace(/\\/g, "/") +
        "/" +
        this.agentName(agent) +
        ".md), propose it with request_approval type agent.update: id " +
        agent +
        ", instructions (the complete new instructions text: everything after the front matter, with the change made, keeping the memory, handoff and finish paragraphs), change (two or three sentences: what changes and which feedback it answers). At most one proposal.",
      `3. If nothing should change, say so in one line. Do not message ${owner()} otherwise.`,
    ].join("\n");
    return this.enqueue({ agent, kind: "learn", priority: PRIORITY.schedule, prompt });
  }

  // --- what the API exposes

  agents() {
    const queued = this.store.queuedJobs();
    const pending = this.store.approvals("pending");
    return this.team().map((id) => {
      const latest = this.store.latestJob(id);
      const lastAgent = this.store
        .messages(id, 20)
        .filter((m) => m.role === "agent")
        .pop();
      const asking = pending.filter((a) => a.agent === id).length;
      let state = "idle";
      if (latest?.status === "running") state = "working";
      else if (asking) state = "asking";
      else if (latest?.status === "done" && this.now() - (latest.endedAt ?? 0) < DONE_FOR_MS) {
        state = "done";
      }
      return {
        id,
        title: this.titleOf(id),
        icon: this.iconOf(id),
        ...this.memoryState(id),
        state,
        asking,
        queued: queued.filter((j) => j.agent === id).length,
        lastLine: lastAgent ? oneLine(lastAgent.text, 120) : null,
        lastAt: lastAgent?.at ?? null,
      };
    });
  }

  /** The Claude Code session behind an agent's thread, to open it in a terminal. */
  threadSession(agent) {
    this.assertAgent(agent);
    const thread = this.store.activeThread(agent);
    return {
      sessionId: thread && (thread.turns > 0 || thread.started) ? thread.sessionId : null,
      cwd: this.paths.brain,
    };
  }

  /**
   * Continue an agent's real Claude Code conversation in a terminal window on the PC. While it
   * is open there, Crew leaves that thread alone (see leaseFree).
   */
  /** Open a file or folder an agent linked, on the PC (core/files.mjs says how). */
  openPath(path) {
    if (!this.openPathFn) throw new HubError(501, "no file opener configured");
    try {
      return this.openPathFn(path, { crewHome: this.paths.home });
    } catch (err) {
      throw new HubError(/no such/.test(err.message) ? 404 : 400, err.message);
    }
  }

  /** claude-face: installed, and on (running and starting with Windows) or off. */
  async faceStatus() {
    if (!this.faceFns) return { installed: false, on: false };
    return this.faceFns.status();
  }

  async setFace(on) {
    if (!this.faceFns) throw new HubError(501, "claude-face isn't set up here");
    try {
      const status = await this.faceFns.set(Boolean(on));
      this.event("face.changed", { on: status.on });
      return status;
    } catch (err) {
      throw new HubError(400, err.message);
    }
  }

  /** Open a web link an agent gave in the PC's default browser. */
  openUrl(url) {
    if (!this.openUrlFn) throw new HubError(501, "no browser opener configured");
    try {
      return this.openUrlFn(url);
    } catch (err) {
      throw new HubError(400, err.message);
    }
  }

  /** A linked text file's contents, for the phone. */
  filePreview(path) {
    if (!this.readPreviewFn) throw new HubError(501, "no file reader configured");
    try {
      return this.readPreviewFn(path, { crewHome: this.paths.home });
    } catch (err) {
      throw new HubError(/no such/.test(err.message) ? 404 : 400, err.message);
    }
  }

  openInTerminal(agent) {
    const { sessionId, cwd } = this.threadSession(agent);
    if (!sessionId)
      throw new HubError(
        409,
        this.titleOf(agent) + " has no conversation yet: send a message first",
      );
    if (this.runningFor(agent)) {
      throw new HubError(
        409,
        this.titleOf(agent) + " is working right now: open it when it is done",
      );
    }
    if (!this.openTerminalFn) throw new HubError(501, "no terminal opener configured");
    this.openTerminalFn({
      agent: this.agentName(agent),
      title: "Crew - " + this.titleOf(agent),
      sessionId,
      cwd,
    });
    return { ok: true };
  }

  messages(agent, limit = 50) {
    this.assertAgent(agent);
    this.syncTerminal(agent);
    return this.store.messages(agent, limit);
  }

  /**
   * One conversation in Crew and the terminal: bring in turns the user had with this agent's
   * session in a terminal since the last look. A transcript written to in the last minute is
   * left for later, so a reply still being written is never cut in half.
   * @returns {number} how many messages were added
   */
  syncTerminal(agent) {
    if (!this.readTranscriptFn) return 0;
    const thread = this.store.activeThread(agent);
    if (!thread?.sessionId || !(thread.started || thread.turns > 0)) return 0;
    const transcript = this.readTranscriptFn(thread.sessionId);
    if (!transcript || this.now() - transcript.mtimeMs < SETTLE_MS) return 0;
    const key = `terminal:${thread.id}`;
    const done = this.store.get(key, 0);
    const turns = terminalTurns(transcript.entries);
    if (turns.length <= done) return 0;
    for (const t of turns.slice(done)) {
      this.store.addMessage({ agent, threadId: thread.id, role: t.role, text: t.text, at: t.at });
    }
    this.store.set(key, turns.length);
    this.event("thread.synced", { agent, added: turns.length - done });
    return turns.length - done;
  }

  job(id) {
    return this.store.job(id);
  }

  budget() {
    return {
      usage: this.store.get("usage"),
      limitHitAt: this.store.get("limitHitAt"),
      paused: Boolean(this.store.get("paused", false)),
      // The phone app is in use here (pairing shows in the window).
      phones: Boolean(this.config.phones),
      quiet: blockedBy(this.now(), this.offset(), this.config.quiet),
      running: [...this.running.keys()],
      queued: this.store.queuedJobs().length,
      autonomousToday: this.autonomousToday(),
    };
  }

  report(date) {
    const { date: today } = localParts(this.now(), this.offset());
    return this.store.get(`report:${date ?? today}`);
  }

  /**
   * Queue the user's message to an agent. Their own messages run first, in any window.
   * @param {string} agent
   * @param {string} text
   */
  /** A file the user uploaded, ready to go with their next message. */
  addAttachment(meta) {
    this.store.addAttachment(meta);
    return publicAttachment(meta);
  }

  attachment(id) {
    const meta = this.store.attachment(id);
    if (!meta) throw new HubError(404, "no such attachment");
    return meta;
  }

  send(agent, text, options = {}) {
    this.assertAgent(agent);
    const words = String(text ?? "").trim();
    const ids = [...new Set(options.attachments ?? [])];
    if (ids.length > MAX_PER_MESSAGE) {
      throw new HubError(400, `at most ${MAX_PER_MESSAGE} files on one message`);
    }
    const files = ids.map((id) => {
      const meta = this.store.attachment(id);
      if (!meta) throw new HubError(400, "an attached file is missing: attach it again");
      return meta;
    });
    if (!words && !files.length) throw new HubError(400, "empty message");
    // The agent gets the files' paths after the user's words, and opens them itself.
    const prompt = [words, attachmentNote(files)].filter(Boolean).join("\n\n");
    const kind = options.kind ?? "chat";
    const job = this.enqueue({
      agent,
      kind,
      priority: PRIORITY.user,
      // On a call the agent is told its reply will be heard, not read.
      prompt: kind === "call" ? `${voiceNote()}\n\n${prompt}` : prompt,
      origin: options.origin === "phone" ? "phone" : "pc",
    });
    // What the chat shows: their own words, even when the run gets a longer prompt.
    const shown = String(options.shown ?? words);
    this.store.addMessage({
      agent,
      jobId: job.id,
      role: "you",
      text: shown,
      at: this.now(),
      attachments: files.map(publicAttachment),
    });
    return job;
  }

  /** Queue any job. */
  enqueue({ agent, kind, priority, prompt, tainted = false, origin = "pc" }) {
    const job = this.store.addJob({
      agent,
      kind,
      priority,
      prompt,
      tainted,
      origin,
      createdAt: this.now(),
    });
    this.event("job.queued", { jobId: job.id, agent, kind });
    queueMicrotask(() => this.tick());
    return job;
  }

  /** Start the agent's next message in a fresh session (the old one stays on disk). */
  newThread(agent) {
    this.assertAgent(agent);
    const thread = this.store.activeThread(agent);
    if (thread) this.store.retireThread(thread.id, "manual");
    this.event("thread.rotated", { agent, reason: "manual" });
  }

  cancel(jobId) {
    const job = this.store.job(jobId);
    if (!job) throw new HubError(404, "no such job");
    if (job.status === "queued") {
      this.store.updateJob(jobId, { status: "cancelled", endedAt: this.now() });
      this.asks.delete(jobId);
      this.event("job.cancelled", { jobId, agent: job.agent });
    } else if (job.status === "running" && this.running.has(job.id)) {
      this.cancelling.add(job.id);
      this.running.get(job.id).kill();
    }
    return this.store.job(jobId);
  }

  /** The kill switch: stop every running turn and hold everything until resumeAll(). */
  stopAll() {
    this.store.set("paused", true);
    this.killAll();
    this.event("hub.paused", {});
  }

  resumeAll() {
    this.store.set("paused", false);
    this.event("hub.resumed", {});
    this.tick();
  }

  // --- approvals

  /**
   * An agent asks the user for an action (through the crew MCP tool). Only the job running right
   * now may ask, and only for its own agent.
   * @param {{ jobId: number, agent: string, type: string, summary: string, why?: string,
   *   payload: Record<string, unknown> }} request
   */
  requestApproval(request) {
    const job = this.store.job(Number(request.jobId));
    if (!job || job.status !== "running" || job.agent !== request.agent) {
      throw new HubError(403, "only the run in progress can ask for approval");
    }
    let clean;
    let preconditions;
    try {
      clean = validateRequest(request, { brainDir: this.paths.brain });
      if (clean.type === "agent.create" && this.team().includes(clean.payload.id)) {
        throw new Error(`${clean.payload.id} is already on the team`);
      }
      preconditions = this.captureFn(clean);
      if (clean.type === "agent.update") {
        // An agent may change only its own instructions; the CEO may propose for anyone.
        if (!this.team().includes(clean.payload.id))
          throw new Error("no agent named " + clean.payload.id);
        if (job.agent !== clean.payload.id && job.agent !== "ceo") {
          throw new Error("you can propose changes to your own instructions only");
        }
        preconditions = {
          definition: this.definitionHashFn(this.paths.agentsDir, this.agentName(clean.payload.id)),
        };
      }
    } catch (err) {
      throw new HubError(400, err.message);
    }
    const taken = new Set(this.store.approvals("pending").map((a) => a.code));
    const risk =
      clean.type === "command" ? (inspectCommand(clean.payload.command)?.reason ?? null) : null;
    const approval = this.store.addApproval({
      id: randomBytes(16).toString("hex"),
      code: approvalCode(this.random, taken),
      agent: job.agent,
      jobId: job.id,
      ...clean,
      preconditions,
      risk,
      tainted: Boolean(job.tainted),
      createdAt: this.now(),
      expiresAt: this.now() + ACTIONS[clean.type].expiresMs,
    });
    this.event("approval.requested", publicApproval(approval));
    return approval;
  }

  approvals(status) {
    return this.store.approvals(status ?? null).map(publicApproval);
  }

  approval(idOrCode) {
    const a = this.store.approval(idOrCode);
    if (!a) throw new HubError(404, "no such approval");
    return publicApproval(a);
  }

  /**
   * The user's answer. Duplicate deliveries of the same answer are harmless; the first answer
   * wins. An approved hub action runs right away, then the agent is told how it went.
   * @param {string} idOrCode
   * @param {{ decision: "approve" | "deny", nonce: string, note?: string }} input
   */
  /**
   * A quick OK for one tool call an agent is about to make (coworker mode): something that
   * can't be undone or reaches other people. The run waits on the answer (gate-hook.mjs polls
   * the request); nothing is carried out here.
   * @param {{ jobId: number, tool: string, summary: string, reason: string }} input
   */
  gateRequest(input) {
    const job = this.store.job(Number(input.jobId));
    if (!job || job.status !== "running") {
      throw new HubError(403, "only the run in progress can ask for a quick OK");
    }
    // Some kinds (follows) can be allowed for the rest of the task; never for a run from email.
    const grant = !job.tainted && Object.hasOwn(GRANTS, input.grant) ? input.grant : null;
    const taken = new Set(this.store.approvals("pending").map((a) => a.code));
    const approval = this.store.addApproval({
      id: randomBytes(16).toString("hex"),
      code: approvalCode(this.random, taken),
      agent: job.agent,
      jobId: job.id,
      type: "gate",
      summary: String(input.summary ?? "").slice(0, 200) || String(input.tool),
      why: String(input.reason ?? "").slice(0, 200),
      payload: { tool: String(input.tool ?? ""), ...(grant ? { grant } : {}) },
      preconditions: {},
      tainted: Boolean(job.tainted),
      createdAt: this.now(),
      expiresAt: this.now() + GATE_WAIT_MS,
    });
    if (grant && this.grants.get(job.id)?.has(grant)) {
      // Already a yes for all of these in this task: on the record, no question.
      this.store.updateApproval(approval.id, {
        status: "approved",
        decision: "approve",
        note: "allowed for this task",
        decidedAt: this.now(),
      });
      this.event("approval.approved", { id: approval.id, code: approval.code, agent: job.agent });
      return publicApproval(this.store.approval(approval.id));
    }
    this.event("approval.requested", publicApproval(approval));
    return publicApproval(approval);
  }

  async decideApproval(idOrCode, input) {
    const approval = this.store.approval(idOrCode);
    if (!approval) throw new HubError(404, "no such approval");
    const nonce = String(input.nonce ?? "");
    if (!nonce) throw new HubError(400, "nonce is required");
    const verdict = decide(approval, { decision: input.decision, nonce, now: this.now() });
    if (!verdict.changed) {
      if (verdict.error) throw new HubError(409, verdict.error);
      return publicApproval(this.store.approval(approval.id));
    }
    if (verdict.status === "expired") {
      this.expireApproval(approval);
      throw new HubError(410, verdict.error);
    }

    this.store.updateApproval(approval.id, {
      status: verdict.status,
      decision: input.decision,
      nonce,
      note: input.note ? String(input.note).slice(0, 500) : null,
      decidedAt: this.now(),
    });
    this.event(`approval.${verdict.status}`, {
      id: approval.id,
      code: approval.code,
      agent: approval.agent,
    });

    // A quick OK: the agent is waiting on it mid-run (gate-hook.mjs) and carries on by itself.
    if (approval.type === "gate") {
      const grant = approval.payload?.grant;
      if (verdict.status === "approved" && grant && input.scope === "task") {
        if (!this.grants.has(approval.jobId)) this.grants.set(approval.jobId, new Set());
        this.grants.get(approval.jobId).add(grant);
      }
      return publicApproval(this.store.approval(approval.id));
    }

    if (verdict.status === "denied") {
      this.notify(
        approval.agent,
        outcomeMessage({ ...approval, status: "denied", note: input.note }),
      );
      return publicApproval(this.store.approval(approval.id));
    }

    const outcome =
      approval.type === "agent.create"
        ? this.createAgent(approval.payload)
        : approval.type === "agent.update"
          ? this.updateAgent(approval)
          : this.executeFn
            ? await this.executeFn(approval)
            : { status: "failed", result: "no executor configured" };
    this.store.updateApproval(approval.id, {
      status: outcome.status,
      result: outcome.result,
      doneAt: this.now(),
    });
    this.event(`approval.${outcome.status}`, {
      id: approval.id,
      code: approval.code,
      agent: approval.agent,
      result: outcome.result,
    });
    // The agent hears back in a turn of its own, so it can confirm or carry on. The same news
    // rides along with its next turn of any kind, in case the user talks to it first (that
    // turn's priority is higher, and the follow-up can wait on the budget).
    const news = outcomeMessage({ ...approval, ...outcome });
    this.notify(approval.agent, news);
    this.enqueue({
      agent: approval.agent,
      kind: "approval",
      priority: PRIORITY.approved,
      prompt: news,
    });
    return publicApproval(this.store.approval(approval.id));
  }

  /** Run once a minute: expire old requests, and flag the ones that need a reminder. */
  approvalsTick() {
    const pending = this.store.approvals("pending", 1000);
    for (const a of expired(pending, this.now())) this.expireApproval(a);
    for (const a of needReminder(pending, this.now())) {
      this.store.updateApproval(a.id, { remindedAt: this.now() });
      this.event("approval.reminder", publicApproval(a));
    }
  }

  expireApproval(approval) {
    this.store.updateApproval(approval.id, { status: "expired", doneAt: this.now() });
    this.event("approval.expired", { id: approval.id, code: approval.code, agent: approval.agent });
    // A quick OK's run already heard "no answer" from the gate; nothing to pass on.
    if (approval.type === "gate") return;
    this.notify(approval.agent, outcomeMessage({ ...approval, status: "expired" }));
  }

  /** A note the agent reads at the start of its next turn, without starting one now. */
  notify(agent, text) {
    const notices = this.store.get("notices", {});
    notices[agent] = [...(notices[agent] ?? []), text];
    this.store.set("notices", notices);
  }

  takeNotices(agent) {
    const notices = this.store.get("notices", {});
    const mine = notices[agent] ?? [];
    if (mine.length) {
      delete notices[agent];
      this.store.set("notices", notices);
    }
    return mine;
  }

  // --- waking agents by themselves

  /** Run once a minute: queue the routines that are due. */
  schedulerTick() {
    // Terminal turns show up in Crew within a couple of minutes, even with no window open.
    for (const id of this.team()) this.syncTerminal(id);
    if (this.store.get("paused", false)) return; // they run when Crew is switched back on
    const now = this.now();
    const offset = this.offset();
    const quiet = blockedBy(now, offset, this.config.quiet);
    const lastRuns = this.store.get("scheduleRuns", {});
    const { date } = localParts(now, offset);

    const { due, skipped } = dueSchedules(this.config.schedules, lastRuns, now, offset);
    for (const s of skipped) {
      lastRuns[s.id] = date;
      // The report costs nothing, so a late one is still built; a late model run is skipped.
      if (s.report) this.makeReport();
      else this.event("schedule.skipped", { id: s.id, reason: "too late today" });
    }
    for (const s of due) {
      if (s.report) {
        lastRuns[s.id] = date;
        this.makeReport();
        continue;
      }
      if (quiet) continue; // later today, once the window ends
      lastRuns[s.id] = date;
      if (this.config.budgetGuard !== false && halfRate(this.store.get("usage"), date, now)) {
        this.event("schedule.skipped", { id: s.id, reason: "weekly use high: every other day" });
        continue;
      }
      if (s.system) {
        const pending = this.store
          .queuedJobs()
          .concat(this.store.jobsWithStatus("running"))
          .some((j) => j.agent === s.system);
        if (pending) continue; // one mail check at a time is enough
        this.enqueue({
          agent: s.system,
          kind: "system",
          priority: PRIORITY.schedule,
          prompt: s.id,
        });
      } else {
        this.enqueue({
          agent: s.agent,
          kind: "schedule",
          priority: PRIORITY.schedule,
          prompt: s.prompt,
        });
      }
      this.event("schedule.fired", { id: s.id });
    }
    this.store.set("scheduleRuns", lastRuns);
  }

  /**
   * Look at the inboxes: wake a department for each new open item. On the very first scan the
   * items already there are only noted, so a backlog does not drain the user's usage at once.
   */
  inboxTick() {
    if (!this.config.inbox?.enabled) return;
    // departments: null means every agent on the team.
    const departments = [
      ...new Set([...(this.config.inbox.departments ?? this.team()), ...this.customIds()]),
    ];
    const items = this.scanInboxesFn(this.paths.brain, departments);
    const seen = this.store.get("inboxSeen", {});
    const baseline = !this.store.get("inboxBaselined", false);
    let woke = 0;
    for (const item of items) {
      if (seen[item.path]) continue;
      seen[item.path] = this.now();
      if (baseline || !isOpen(item)) continue;
      const job = this.enqueue({
        agent: item.dept,
        kind: "inbox",
        priority: PRIORITY.urgent,
        prompt: wakePrompt(item),
        tainted: !item.trusted,
      });
      // A handoff from a teammate: both chats show it, and the reply goes back when it's done.
      if (item.from !== item.dept && this.team().includes(item.from)) {
        this.store.set(`handoff:${job.id}`, {
          from: item.from,
          path: item.path,
          summary: item.summary,
        });
        this.teamLine("handoff", item.from, item.dept, item.summary || item.path);
      }
      this.event("inbox.woke", { agent: item.dept, path: item.path, trusted: item.trusted });
      woke += 1;
    }
    this.store.set("inboxSeen", seen);
    if (baseline) {
      this.store.set("inboxBaselined", true);
      this.event("inbox.baseline", { count: items.length });
    }
    return woke;
  }

  /** Build the morning report from the events since the last one. */
  makeReport() {
    const since = this.store.get("reportSeq", 0);
    const events = this.store.eventsSince(since, 5000);
    const jobs = new Map(
      this.store.jobsByIds(events.map((e) => e.data?.jobId).filter(Boolean)).map((j) => [j.id, j]),
    );
    const report = buildReport(events, { jobs });
    const { date } = localParts(this.now(), this.offset());
    const stored = { date, at: this.now(), ...report };
    this.store.set(`report:${date}`, stored);
    this.store.set("reportSeq", events.length ? events[events.length - 1].seq : since);
    this.event("report", { date, lines: report.lines });
    return stored;
  }

  autonomousToday() {
    return this.store.countStartedSince(startOfLocalDay(this.now(), this.offset()), "chat");
  }

  // --- the queue

  /**
   * Start every queued job that may run now. Agents work side by side up to config.maxRuns at
   * once, each agent one run at a time (its thread is one conversation). A call may take one
   * slot beyond the limit, so the user is never left waiting on the phone. A job held back only
   * because its agent or every slot is busy needs no retry timer: each run ticks when it ends.
   */
  tick() {
    if (this.stopped || this.store.get("paused", false)) return;
    const busy = new Set([...this.running.values()].map((r) => r.agent));
    const max = this.config.maxRuns ?? 3;
    const now = this.now();
    const usage = this.store.get("usage");
    const limitHitAt = this.store.get("limitHitAt");
    const quiet = blockedBy(now, this.offset(), this.config.quiet);
    const cap = this.config.maxAutonomousPerDay;
    const capped = cap != null && this.autonomousToday() >= cap;
    let sessions = null;
    const openSessions = () => (sessions ??= this.sessionsFn(this.bin));
    let deferred = false;

    for (const job of this.store.queuedJobs()) {
      if (busy.has(job.agent)) continue;
      // A call, and a teammate's answer someone is waiting on, may take one slot past the limit.
      const spare = job.kind === "call" || job.kind === "ask";
      if (this.running.size >= (spare ? max + 1 : max)) continue;
      const autonomous = job.priority !== PRIORITY.user;
      if (autonomous && (quiet || capped)) {
        deferred = true;
        continue;
      }
      const userBusy =
        autonomous && openSessions().some((s) => s.kind === "interactive" && s.status === "busy");
      // config.budgetGuard: false lifts every usage cap (for a recording or a crunch).
      const verdict =
        this.config.budgetGuard === false
          ? { ok: true, reason: null, warn: false }
          : admit(job, usage, { now, limitHitAt, userBusy });
      if (!verdict.ok || !this.leaseFree(job.agent, openSessions)) {
        deferred = true;
        continue;
      }
      busy.add(job.agent);
      const run = (
        job.kind === "system" ? this.runSystemJob(job) : this.runJob(job, verdict.warn)
      ).catch((err) => this.failJob(job, String(err?.message ?? err)));
      this.current.add(run);
      run.finally(() => this.current.delete(run));
    }
    if (deferred) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.tick(), 60_000);
      this.retryTimer.unref?.();
    }
  }

  /** A thread may not be resumed while the user has its session open themselves. */
  leaseFree(agent, openSessions) {
    if (!this.team().includes(agent)) return true;
    const thread = this.store.activeThread(agent);
    if (!thread || thread.turns === 0) return true;
    return !openSessions().some((s) => s.sessionId === thread.sessionId);
  }

  async runJob(job, warn) {
    if (job.kind === "approval") {
      const pending = this.store.get("notices", {})[job.agent] ?? [];
      if (!pending.includes(job.prompt)) {
        // An earlier turn already carried this news; no need to spend a run on it.
        this.finish(job, "done", { result: "(already told in an earlier turn)" });
        return;
      }
    }
    const definitionText = readFileSync(
      join(this.paths.agentsDir, `${this.agentName(job.agent)}.md`),
      "utf8",
    );
    const agentHash = createHash("sha256").update(definitionText).digest("hex").slice(0, 16);

    let thread = this.store.activeThread(job.agent);
    let opening = "";
    if (thread) {
      const reason = rotationReason(
        { ...thread, autonomous: job.kind !== "chat" },
        { now: this.now(), agentHash },
      );
      if (reason) {
        opening = handover(this.store.messages(job.agent, 12, thread.id));
        this.store.retireThread(thread.id, reason);
        this.event("thread.rotated", { agent: job.agent, reason });
        thread = null;
      }
    }
    if (!thread) {
      thread = this.store.createThread({
        agent: job.agent,
        sessionId: randomUUID(),
        createdAt: this.now(),
        agentHash,
      });
    }

    // Run the agent the way the terminal does (its own definition, the user's settings, skills
    // and connectors), plus Crew's gate for quick OKs and every drive as a working directory.
    const approvals = Boolean(this.paths.mcpServer);
    // One file per agent: another agent's run may be starting from its own at the same moment.
    const settingsPath = join(this.paths.runs, `${job.agent}.settings.json`);
    const mcpPath = join(this.paths.runs, `${job.agent}.mcp.json`);
    const crewEnv = {
      CREW_WORKER: "1",
      CREW_JOB: String(job.id),
      CREW_AGENT: job.agent,
      CREW_PORT: String(this.paths.port),
      CREW_TOKEN_FILE: this.paths.token ?? "",
      CREW_TAINTED: job.tainted ? "1" : "",
      CREW_OWNER: this.config.owner ?? "",
      // For claude-face: clicking the face on this agent opens it in the Crew window.
      CREW_CLI: this.paths.cli ?? "",
      CREW_NODE: this.nodeBin,
      // No usage reports home from tools that send them (HyperFrames reads both).
      HYPERFRAMES_NO_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
    };
    if (approvals) {
      // The crew server learns which run it serves from its environment.
      writeFileSync(
        mcpPath,
        JSON.stringify({
          mcpServers: {
            crew: {
              type: "stdio",
              command: this.nodeBin,
              args: [this.paths.mcpServer],
              env: crewEnv,
            },
          },
        }),
      );
    }
    writeFileSync(
      settingsPath,
      JSON.stringify(runSettings({ gateHook: this.paths.gateHook, nodeBin: this.nodeBin })),
    );

    const briefPath = join(this.paths.brain, "BRIEF.md");
    const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "";
    const args = buildArgs({
      agent: this.agentName(job.agent),
      sessionId: thread.sessionId,
      resume: thread.turns > 0 || Boolean(thread.started),
      settingsPath,
      dirs: this.workDirs,
      tainted: Boolean(job.tainted),
      appendPrompt: crewNote({
        today: localParts(this.now(), this.offset()).date,
        brief,
        name: this.titleOf(job.agent),
        tainted: Boolean(job.tainted),
        crew: this.paths.cli ? `"${this.nodeBin}" "${this.paths.cli}"` : undefined,
      }),
      ...(approvals ? { mcpConfigPath: mcpPath } : {}),
      partial: job.kind === "call",
    });
    // On a call, each sentence goes to the phone as soon as it is written.
    const splitter = job.kind === "call" ? createSplitter() : null;
    const say = (sentences) => {
      for (const text of sentences)
        this.event("job.say", { jobId: job.id, agent: job.agent, text });
    };
    const notices = this.takeNotices(job.agent).filter((n) => n !== job.prompt);

    const texts = [];
    let result = null;
    let lastContext = null;
    let wrote = false;
    /** Files this run wrote, so only they are committed to the brain afterwards. */
    const files = new Set();

    /** How the last run was started (for tests and debugging). */
    this.lastRun = { args, env: crewEnv, settingsPath };
    const handle = this.runTurnFn({
      bin: this.bin,
      args,
      prompt: [opening, ...notices, job.prompt].filter(Boolean).join("\n\n"),
      cwd: this.paths.brain,
      env: { ...process.env, ...crewEnv },
      timeoutMs: job.kind === "call" ? TIMEOUTS.call : TIMEOUTS.chat,
      onEvent: (e) => {
        if (e.kind === "init") {
          if (!thread.started) this.store.markThreadStarted(thread.id);
        } else if (e.kind === "limits") {
          this.store.set("usage", {
            fiveHour: e.fiveHour,
            sevenDay: e.sevenDay,
            resetsAt: e.resetsAt,
            at: this.now(),
          });
          this.event("budget", { fiveHour: e.fiveHour, sevenDay: e.sevenDay });
        } else if (e.kind === "text") {
          texts.push(e.text);
          if (e.contextTokens) lastContext = e.contextTokens;
        } else if (e.kind === "tool") {
          if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(e.name)) {
            wrote = true;
            const path = e.input?.file_path ?? e.input?.notebook_path;
            if (path) files.add(String(path));
          }
          this.event("job.tool", { jobId: job.id, agent: job.agent, tool: e.name });
        } else if (e.kind === "delta" && splitter) {
          say(splitter.push(e.text));
        } else if (e.kind === "blockEnd" && splitter) {
          say(splitter.flush());
        } else if (e.kind === "result") {
          result = e;
        }
      },
    });

    this.running.set(job.id, { agent: job.agent, kind: job.kind, kill: handle.kill });
    this.store.updateJob(job.id, {
      status: "running",
      startedAt: this.now(),
      threadId: thread.id,
      pid: handle.pid ?? null,
    });
    this.event("job.started", { jobId: job.id, agent: job.agent, kind: job.kind, warn });

    const exit = await handle.done;
    this.running.delete(job.id);

    if (this.cancelling.delete(job.id)) {
      this.finish(job, "cancelled", { error: `stopped by ${owner()}` });
    } else if (exit.timedOut) {
      this.finish(job, "failed", { error: "timed out" });
    } else if (result && !result.isError) {
      const reply = result.text || texts.join("\n\n");
      this.store.addMessage({
        agent: job.agent,
        threadId: thread.id,
        jobId: job.id,
        role: "agent",
        text: reply,
        at: this.now(),
      });
      this.store.recordTurn(thread.id, lastContext);
      this.finish(job, "done", { result: reply, usage: JSON.stringify(result.usage ?? null) });
      if (wrote) {
        this.afterWrite({ agent: job.agent, jobId: job.id, kind: job.kind, files: [...files] });
      }
    } else {
      const detail = result?.text || exit.stderr || `exit ${exit.code}`;
      if (SESSION_IN_USE.test(detail) && !thread.started) {
        // The session exists (an earlier first turn created it, then died): resume it instead.
        this.store.markThreadStarted(thread.id);
        this.store.updateJob(job.id, { status: "queued", startedAt: null, pid: null });
        this.event("job.retry", {
          jobId: job.id,
          agent: job.agent,
          reason: "resume existing session",
        });
        this.tick();
        return;
      }
      if (LOST_SESSION.test(detail)) this.store.retireThread(thread.id, "lost");
      if (LIMIT_TEXT.test(detail)) this.store.set("limitHitAt", this.now());
      this.finish(job, "failed", { error: oneLine(detail, 300) });
    }
    this.tick();
  }

  /** Run a brain script (the mailroom) in a run slot, like an agent turn. */
  async runSystemJob(job) {
    const spec = SYSTEM_SCRIPTS[job.agent];
    if (!spec || !this.runScriptFn) throw new Error(`no system job named ${job.agent}`);
    const handle = this.runScriptFn({
      script: join(this.paths.brain, spec.script),
      cwd: this.paths.brain,
      timeoutMs: spec.timeoutMs,
    });
    this.running.set(job.id, { agent: job.agent, kind: "system", kill: handle.kill });
    this.store.updateJob(job.id, {
      status: "running",
      startedAt: this.now(),
      pid: handle.pid ?? null,
    });
    this.event("job.started", { jobId: job.id, agent: job.agent, kind: "system" });

    const exit = await handle.done;
    this.running.delete(job.id);
    const tail = oneLine(exit.stdout || exit.stderr || "", 300);
    if (this.cancelling.delete(job.id))
      this.finish(job, "cancelled", { error: `stopped by ${owner()}` });
    else if (exit.timedOut) this.finish(job, "failed", { error: "timed out" });
    else if (exit.code === 0) {
      this.finish(job, "done", { result: tail });
      this.inboxTick(); // what it filed wakes its departments now, not at the next rescan
    } else this.finish(job, "failed", { error: tail || `exit ${exit.code}` });
    this.tick();
  }

  failJob(job, error) {
    this.running.delete(job.id);
    this.finish(job, "failed", { error });
    this.tick();
  }

  finish(job, status, fields) {
    this.store.updateJob(job.id, { status, endedAt: this.now(), ...fields });
    this.memorySyncFinished(job, status);
    this.teamFinished(job, status, fields);
    this.grants.delete(job.id);
    if (status !== "done" && this.team().includes(job.agent)) {
      const text = status === "cancelled" ? "Stopped." : `Couldn't finish: ${fields.error}`;
      this.store.addMessage({
        agent: job.agent,
        jobId: job.id,
        role: "note",
        text,
        at: this.now(),
      });
    }
    this.event(`job.${status}`, { jobId: job.id, agent: job.agent, error: fields.error ?? null });
  }

  // --- agents talking to each other (core/teamtalk.mjs)

  /** A line in both agents' chats: a handoff, a question, a reply or an answer. */
  teamLine(kind, from, to, text) {
    const lines = teamLines(kind, {
      fromTitle: this.titleOf(from),
      toTitle: this.titleOf(to),
      text,
    });
    const at = this.now();
    this.store.addMessage({ agent: from, role: "team", text: lines.forFrom, at });
    this.store.addMessage({ agent: to, role: "team", text: lines.forTo, at });
    this.event("team.talk", { kind, from, to, agent: from });
    this.event("team.talk", { kind, from, to, agent: to });
  }

  /**
   * An agent asks a teammate mid-task (ask_teammate). The teammate runs at once, on a spare
   * slot if need be; the asking run waits for the answer (mcp-crew.mjs polls the job).
   * @param {{ jobId: number, agent: string, question: string }} input
   */
  ask(input) {
    const asking = this.store.job(Number(input.jobId));
    if (!asking || asking.status !== "running") {
      throw new HubError(403, "only a run in progress can ask a teammate");
    }
    const to = String(input.agent ?? "")
      .trim()
      .toLowerCase();
    const question = String(input.question ?? "").trim();
    if (!question) throw new HubError(400, "say what you want to ask");
    const waiting = new Set([...this.asks.values()].map((a) => a.from));
    const why = askBlocked({
      from: asking.agent,
      to,
      askingJob: asking,
      team: this.team(),
      waiting,
    });
    if (why) throw new HubError(409, why);
    const job = this.enqueue({
      agent: to,
      kind: "ask",
      priority: PRIORITY.user,
      prompt: askPrompt({ fromTitle: this.titleOf(asking.agent), question }),
      tainted: Boolean(asking.tainted),
    });
    this.asks.set(job.id, { from: asking.agent, fromJob: asking.id, to });
    this.teamLine("ask", asking.agent, to, question);
    return { job: this.job(job.id) };
  }

  /** When a handoff or a question is done, the one who asked hears back. */
  teamFinished(job, status, fields) {
    // Nobody is waiting any more for questions this run asked and that haven't started.
    for (const [askId, a] of this.asks) {
      if (a.fromJob === job.id && this.store.job(askId)?.status === "queued") this.cancel(askId);
    }
    const ask = this.asks.get(job.id);
    if (ask) {
      this.asks.delete(job.id);
      if (status === "done") this.teamLine("answer", ask.from, ask.to, fields.result ?? "");
    }
    const handoff = job.kind === "inbox" ? this.store.get(`handoff:${job.id}`) : null;
    if (handoff && status === "done" && this.team().includes(handoff.from)) {
      this.teamLine("reply", handoff.from, job.agent, fields.result ?? "");
      // Two agents handing work back and forth stop waking each other after a few rounds.
      const key = `replies:${[handoff.from, job.agent].sort().join(":")}`;
      const now = this.now();
      const recent = this.store.get(key, []).filter((t) => now - t < REPLY_LIMIT.perMs);
      if (recent.length >= REPLY_LIMIT.count) {
        this.event("team.reply_held", { from: job.agent, to: handoff.from, agent: handoff.from });
        return;
      }
      this.store.set(key, [...recent, now]);
      this.enqueue({
        agent: handoff.from,
        kind: "reply",
        priority: PRIORITY.urgent,
        prompt: replyPrompt({
          byTitle: this.titleOf(job.agent),
          path: handoff.path,
          result: fields.result,
        }),
        tainted: Boolean(job.tainted),
      });
    }
  }

  event(type, data) {
    const at = this.now();
    const seq = this.store.addEvent(type, data, at);
    this.emit("event", { seq, at, type, data });
    this.pushOut({ type, data });
    this.desktopOut({ type, data });
  }

  /** Quick OKs, approvals and notices as a desktop notification (config.desktopNotify). */
  desktopOut({ type, data }) {
    if (!this.notifyFn || this.config.desktopNotify === false) return;
    if (type === "approval.requested") {
      this.notifyFn({
        title: `${this.titleOf(data.agent)} needs your OK`,
        body: String(data.summary ?? ""),
      });
    } else if (type === "notify") {
      this.notifyFn({ title: String(data.title ?? "Crew"), body: String(data.body ?? "") });
    }
  }

  /** A notice for the user from a command or an agent: a desktop notification and a line in the window. */
  tellUser({ title, body }) {
    const clean = {
      title: String(title ?? "Crew").slice(0, 80),
      body: String(body ?? "").slice(0, 240),
    };
    if (!clean.body) throw new HubError(400, "say what to tell them");
    this.event("notify", clean);
    return { ok: true };
  }

  /**
   * The user hung up on a call that was taking long: ring them when the job is done. Only for a
   * call that is still queued or running.
   */
  callBack(jobId) {
    const job = this.store.job(Number(jobId));
    if (!job || job.kind !== "call") throw new HubError(404, "no such call");
    if (job.status === "queued" || job.status === "running")
      this.store.set(`callback:${job.id}`, true);
    return { job: this.job(job.id), callBack: job.status === "queued" || job.status === "running" };
  }

  // --- phones

  /**
   * Show a pairing code (on the PC only). Typing it into the app within 5 minutes pairs that
   * phone; five wrong guesses cancel it.
   */
  startPairing() {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(8);
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    this.pairing = { code, expiresAt: this.now() + PAIRING_TTL_MS, failures: 0 };
    return { code, expiresAt: this.pairing.expiresAt };
  }

  /** Trade the pairing code for this phone's own key. The hub keeps only the key's hash. */
  claimPairing(code, name) {
    const p = this.pairing;
    if (!p || p.expiresAt < this.now()) {
      this.pairing = null;
      throw new HubError(401, "no pairing code is open: make a new one on the PC");
    }
    const given = String(code ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (given !== p.code) {
      p.failures += 1;
      if (p.failures >= PAIRING_MAX_FAILURES) this.pairing = null;
      throw new HubError(401, "wrong pairing code");
    }
    this.pairing = null;
    const token = randomBytes(32).toString("base64url");
    const device = this.store.addDevice({
      id: randomUUID(),
      name: String(name ?? "phone").slice(0, 60) || "phone",
      tokenHash: hashKey(token),
      createdAt: this.now(),
    });
    this.event("device.paired", { id: device.id, name: device.name });
    return { deviceId: device.id, token };
  }

  /** The paired phone a key belongs to, or null. */
  deviceForKey(token) {
    if (!token) return null;
    const device = this.store.deviceByTokenHash(hashKey(token));
    if (device && (device.lastSeen ?? 0) < this.now() - 60_000) {
      this.store.updateDevice(device.id, { lastSeen: this.now() });
    }
    return device ?? null;
  }

  setPushToken(deviceId, pushToken) {
    const value = String(pushToken ?? "").trim();
    if (!value || value.length > 4096) throw new HubError(400, "bad push token");
    this.store.updateDevice(deviceId, { pushToken: value });
  }

  revokeDevice(id) {
    const device = this.store.device(id);
    if (!device) throw new HubError(404, "no such device");
    this.store.updateDevice(id, { revokedAt: device.revokedAt ?? this.now(), pushToken: null });
    this.event("device.revoked", { id, name: device.name });
  }

  devices() {
    return this.store.devices().map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeen: d.lastSeen,
      revoked: Boolean(d.revokedAt),
      push: Boolean(d.pushToken),
    }));
  }

  /** Send the event to every paired phone, if it is one that should reach the phone. */
  pushOut(event) {
    if (!this.pushFn) return;
    const job = event.data?.jobId ? this.store.job(event.data.jobId) : null;
    const callBack = job ? Boolean(this.store.get(`callback:${job.id}`, false)) : false;
    const quiet = Boolean(blockedBy(this.now(), this.offset(), this.config.quiet));
    const titles = Object.fromEntries(this.team().map((id) => [id, this.titleOf(id)]));
    const message = pushFor(event, { job, callBack, quiet, titles });
    if (!message) return;
    for (const d of this.store.devices()) {
      if (d.revokedAt || !d.pushToken) continue;
      this.pushFn(d.pushToken, message).then((r) => {
        if (r.ok) return;
        this.store.set("push:lastError", { at: this.now(), error: r.error ?? "unknown" });
        if (r.unregistered) this.store.updateDevice(d.id, { pushToken: null });
      });
    }
  }
}

/** How long a run waits on a quick OK before taking it as a no. */
const GATE_WAIT_MS = 15 * 60_000;
/** A transcript quiet this long has no reply still being written. */
const SETTLE_MS = 60_000;
const PAIRING_TTL_MS = 5 * 60_000;
const PAIRING_MAX_FAILURES = 5;
const hashKey = (token) => createHash("sha256").update(String(token)).digest("hex");

export class HubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function oneLine(text, max) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What an approval looks like outside the hub: everything except the reply nonce. */
function publicApproval(a) {
  const copy = { ...a };
  delete copy.nonce;
  return copy;
}

/** What the chat needs to show an attachment (and open it on the PC). */
function publicAttachment(meta) {
  return {
    id: meta.id,
    name: meta.name,
    type: meta.type,
    size: meta.size,
    path: meta.path,
    kind: kindOf(meta.type),
  };
}
