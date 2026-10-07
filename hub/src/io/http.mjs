// The hub's HTTP API, bound to 127.0.0.1 only. Every route except /v1/health needs a bearer
// key: requests forwarded by `tailscale serve` also arrive from localhost, so the source
// address proves nothing. The Host header is checked to block DNS rebinding.
//
// Two kinds of key: the PC's local token (the CLI, the mod, the Crew window) and each paired
// phone's own key. A phone can do what the user does day to day; pairing new phones, listing or
// revoking them, and opening the window need the PC's key.

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HubError } from "../hub.mjs";
import { saveUpload, sendFile } from "./attachments.mjs";
import { MAX_ATTACHMENT_BYTES } from "../core/attachments.mjs";

const MAX_BODY = 64 * 1024;

/**
 * The Crew window's files. They hold no data and no secrets, so they are served without the
 * token; everything they show comes from the token-protected API.
 */
const WEB = new URL("../../web/", import.meta.url);
const STATIC = {
  "/": { file: new URL("index.html", WEB), type: "text/html; charset=utf-8" },
  "/app.js": { file: new URL("app.js", WEB), type: "text/javascript; charset=utf-8" },
  "/app.css": { file: new URL("app.css", WEB), type: "text/css; charset=utf-8" },
  "/icon.png": { file: new URL("icon.png", WEB), type: "image/png" },
  "/faces.mjs": {
    file: new URL("../../../shared/faces.mjs", import.meta.url),
    type: "text/javascript; charset=utf-8",
  },
  "/links.mjs": {
    file: new URL("../../../shared/links.mjs", import.meta.url),
    type: "text/javascript; charset=utf-8",
  },
};
const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

async function serveStatic(res, entry) {
  res.writeHead(200, {
    "content-type": entry.type,
    "cache-control": entry.cache ?? "no-store",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
  });
  res.end(await readFile(entry.file));
}

/**
 * @param {import("../hub.mjs").Hub} hub
 * @param {{ port: number, token: string, extraHosts?: string[], remoteHost?: string | null,
 *   findRemoteHost?: () => string | null }} options
 *   remoteHost: this PC's Tailscale name, which phones use (and which is also an allowed host)
 *   findRemoteHost: looks the name up again, for a hub that started before Tailscale was up
 */
export function createApi(hub, options) {
  const hosts = new Set([
    `127.0.0.1:${options.port}`,
    `localhost:${options.port}`,
    ...(options.extraHosts ?? []),
    ...(options.remoteHost ? [options.remoteHost] : []),
  ]);
  const expected = Buffer.from(options.token);
  let remoteHost = options.remoteHost ?? null;
  let lookedUpAt = 0;
  const LOOKUP_EVERY_MS = 30_000;

  /** A Tailscale name the hub didn't know at start (Tailscale came up later) is learned once. */
  const allowedHost = (host) => {
    if (hosts.has(host)) return true;
    if (!options.findRemoteHost || !host.endsWith(".ts.net")) return false;
    if (Date.now() - lookedUpAt < LOOKUP_EVERY_MS) return false;
    lookedUpAt = Date.now();
    const name = options.findRemoteHost();
    if (!name || name !== host) return false;
    remoteHost = name;
    hosts.add(name);
    return true;
  };

  /** @returns {{ kind: "local" } | { kind: "device", device: object } | null} */
  const authorize = (req) => {
    const header = String(req.headers.authorization ?? "");
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const given = Buffer.from(key);
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return { kind: "local" };
    }
    const device = key ? hub.deviceForKey(key) : null;
    return device ? { kind: "device", device } : null;
  };
  const localOnly = (auth) => {
    if (auth.kind !== "local") throw new HubError(403, "only the PC can do that");
  };

  // One-time codes for opening the Crew window: `crew open` asks for one with the key, the
  // window trades it for the key. The key itself never appears in an address bar or history.
  /** @type {Map<string, number>} code -> expiry (epoch ms) */
  const windowCodes = new Map();
  /** Crew windows connected right now (their event streams say window=1). */
  let openWindows = 0;
  const countWindow = (delta) => (openWindows += delta);
  const CODE_TTL_MS = 60_000;
  const newWindowCode = () => {
    const now = Date.now();
    for (const [c, expiry] of windowCodes) if (expiry < now) windowCodes.delete(c);
    const code = randomBytes(9).toString("base64url");
    windowCodes.set(code, now + CODE_TTL_MS);
    return code;
  };
  const redeemWindowCode = (code) => {
    const expiry = windowCodes.get(String(code ?? ""));
    windowCodes.delete(String(code ?? ""));
    return Boolean(expiry && expiry >= Date.now());
  };

  const routes = [
    ["GET", /^\/v1\/agents$/, () => ({ agents: hub.agents() })],
    [
      "POST",
      /^\/v1\/gate$/,
      async (req, _m, _url, auth) => {
        localOnly(auth); // only runs on this PC ask
        return { approval: hub.gateRequest(await readJson(req)) };
      },
    ],
    [
      "POST",
      /^\/v1\/threads\/([a-z][a-z0-9]*)\/feedback$/,
      async (req, m) => hub.feedback(m[1], await readJson(req)),
    ],
    [
      "POST",
      /^\/v1\/agents\/([a-z][a-z0-9]*)\/sync$/,
      (_req, m, _url, auth) => hub.syncMemory(m[1], auth.kind === "device" ? "phone" : "pc"),
    ],
    [
      "POST",
      /^\/v1\/agents\/new$/,
      async (req, _m, _url, auth) => {
        const { brief, title, icon } = await readJson(req);
        return {
          job: hub.draftAgent(brief, auth.kind === "device" ? "phone" : "pc", { title, icon }),
        };
      },
    ],
    [
      "POST",
      /^\/v1\/agents\/([a-z][a-z0-9]*)\/profile$/,
      async (req, m) => {
        const { title, icon } = await readJson(req);
        return hub.setProfile(m[1], { title, icon });
      },
    ],
    [
      "GET",
      /^\/v1\/threads\/([a-z][a-z0-9]*)\/messages$/,
      (_req, m, url) => ({
        messages: hub.messages(m[1], Number(url.searchParams.get("limit") ?? 50)),
      }),
    ],
    [
      "POST",
      /^\/v1\/threads\/([a-z][a-z0-9]*)\/messages$/,
      async (req, m, _url, auth) => {
        const body = await readJson(req);
        // "Tell it now": a note for the run in progress (an ordinary message when there is none).
        if (body.now === true) {
          return hub.tweak(m[1], body.text, { origin: auth.kind === "device" ? "phone" : "pc" });
        }
        return {
          job: hub.send(m[1], body.text, {
            origin: auth.kind === "device" ? "phone" : "pc",
            kind: body.mode === "call" ? "call" : "chat",
            attachments: Array.isArray(body.attachments) ? body.attachments.map(String) : [],
          }),
        };
      },
    ],
    [
      "POST",
      /^\/v1\/threads\/([a-z][a-z0-9]*)\/new$/,
      (_req, m) => {
        hub.newThread(m[1]);
        return { ok: true };
      },
    ],
    [
      "GET",
      /^\/v1\/jobs\/(\d+)$/,
      (_req, m) => {
        const job = hub.job(Number(m[1]));
        if (!job) throw new HubError(404, "no such job");
        return { job };
      },
    ],
    ["POST", /^\/v1\/jobs\/(\d+)\/cancel$/, (_req, m) => ({ job: hub.cancel(Number(m[1])) })],
    ["POST", /^\/v1\/jobs\/(\d+)\/callback$/, (_req, m) => hub.callBack(Number(m[1]))],
    ["GET", /^\/v1\/threads\/([a-z][a-z0-9]*)\/session$/, (_req, m) => hub.threadSession(m[1])],
    [
      "POST",
      /^\/v1\/threads\/([a-z][a-z0-9]*)\/terminal$/,
      (_req, m, _url, auth) => {
        localOnly(auth); // it opens a window on the PC
        return hub.openInTerminal(m[1]);
      },
    ],
    // A file or folder an agent linked: opened on the PC, or its text shown on the phone.
    ["POST", /^\/v1\/open$/, async (req) => hub.openPath((await readJson(req)).path)],
    [
      "POST",
      /^\/v1\/open-url$/,
      async (req, _m, _url, auth) => {
        localOnly(auth); // the Crew window's links open in the PC's own browser
        return hub.openUrl((await readJson(req)).url);
      },
    ],
    ["GET", /^\/v1\/file$/, (_req, _m, url) => hub.filePreview(url.searchParams.get("path"))],
    [
      "POST",
      /^\/v1\/notify$/,
      async (req, _m, _url, auth) => {
        localOnly(auth); // commands and agents on this PC tell the user something
        return hub.tellUser(await readJson(req));
      },
    ],
    [
      "POST",
      /^\/v1\/restart$/,
      (_req, _m, _url, auth) => {
        localOnly(auth); // `crew setup` after an update
        setTimeout(() => hub.emit("restart"), 50);
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/v1\/ask$/,
      async (req, _m, _url, auth) => {
        localOnly(auth); // an agent's run on this PC asks a teammate
        return hub.ask(await readJson(req));
      },
    ],
    ["GET", /^\/v1\/face$/, () => hub.faceStatus()],
    [
      "POST",
      /^\/v1\/jobs\/(\d+)\/tweaks\/take$/,
      (_req, m, _url, auth) => {
        localOnly(auth); // the tweak hook of a run on this PC
        return hub.takeTweaks(m[1]);
      },
    ],
    [
      "POST",
      /^\/v1\/jobs\/(\d+)\/progress$/,
      async (req, m, _url, auth) => {
        localOnly(auth); // an agent's run on this PC (set_progress)
        return hub.setProgress(m[1], (await readJson(req)).steps);
      },
    ],
    [
      "POST",
      /^\/v1\/checks$/,
      async (req, _m, _url, auth) => {
        localOnly(auth); // an agent's run on this PC schedules a check
        return { check: hub.addCheck(await readJson(req)) };
      },
    ],
    [
      "GET",
      /^\/v1\/checks$/,
      (_req, _m, url) => ({ checks: hub.checks(url.searchParams.get("agent") || null) }),
    ],
    [
      "POST",
      /^\/v1\/checks\/([0-9a-f]+)\/cancel$/,
      async (req, m) => {
        const body = await readJson(req).catch(() => ({}));
        return { check: hub.cancelCheck(m[1], body?.by === "agent" ? "agent" : "user") };
      },
    ],
    [
      "POST",
      /^\/v1\/face$/,
      async (req, _m, _url, auth) => {
        localOnly(auth); // it starts or closes an app on the PC
        return hub.setFace((await readJson(req)).on);
      },
    ],
    ["GET", /^\/v1\/budget$/, () => hub.budget()],
    [
      "GET",
      /^\/v1\/report$/,
      (_req, _m, url) => ({ report: hub.report(url.searchParams.get("date") ?? undefined) }),
    ],
    ["POST", /^\/v1\/report$/, () => ({ report: hub.makeReport() })],
    [
      "GET",
      /^\/v1\/approvals$/,
      (_req, _m, url) => ({
        approvals: hub.approvals(url.searchParams.get("status") ?? undefined),
      }),
    ],
    [
      "POST",
      /^\/v1\/approvals$/,
      async (req) => ({ approval: hub.requestApproval(await readJson(req)) }),
    ],
    ["GET", /^\/v1\/approvals\/([A-Za-z0-9-]+)$/, (_req, m) => ({ approval: hub.approval(m[1]) })],
    [
      "POST",
      /^\/v1\/approvals\/([A-Za-z0-9-]+)\/decision$/,
      async (req, m) => ({ approval: await hub.decideApproval(m[1], await readJson(req)) }),
    ],
    [
      "POST",
      /^\/v1\/stop-all$/,
      () => {
        hub.stopAll();
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/v1\/resume-all$/,
      () => {
        hub.resumeAll();
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/v1\/pair\/start$/,
      (_req, _m, _url, auth) => {
        localOnly(auth);
        return {
          ...hub.startPairing(),
          hubUrl: remoteHost ? `https://${remoteHost}` : null,
        };
      },
    ],
    [
      "GET",
      /^\/v1\/devices$/,
      (_req, _m, _url, auth) => {
        localOnly(auth);
        return { devices: hub.devices() };
      },
    ],
    [
      "POST",
      /^\/v1\/devices\/([a-f0-9-]+)\/revoke$/,
      (_req, m, _url, auth) => {
        localOnly(auth);
        hub.revokeDevice(m[1]);
        return { ok: true };
      },
    ],
    [
      "GET",
      /^\/v1\/devices\/me$/,
      (_req, _m, _url, auth) => ({
        device: auth.kind === "device" ? { id: auth.device.id, name: auth.device.name } : null,
      }),
    ],
    [
      "POST",
      /^\/v1\/devices\/me\/push$/,
      async (req, _m, _url, auth) => {
        if (auth.kind !== "device") throw new HubError(400, "only a paired phone has a push token");
        hub.setPushToken(auth.device.id, (await readJson(req)).pushToken);
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/v1\/devices\/me\/unpair$/,
      (_req, _m, _url, auth) => {
        if (auth.kind !== "device") throw new HubError(400, "the PC is not a paired phone");
        hub.revokeDevice(auth.device.id);
        return { ok: true };
      },
    ],
    [
      "GET",
      /^\/v1\/agents\/([a-z0-9-]+)\/skills$/,
      (_req, m) => ({ skills: hub.skillsOf(m[1]), score: hub.score(m[1]) }),
    ],
    [
      "GET",
      /^\/v1\/events\/poll$/,
      (_req, _m, url) =>
        pollEvents(
          hub,
          Number(url.searchParams.get("since") ?? 0),
          Number(url.searchParams.get("wait") ?? 0),
        ),
    ],
  ];

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (!allowedHost(String(req.headers.host ?? ""))) throw new HubError(421, "unexpected host");
      if (req.method === "GET" && url.pathname === "/v1/health")
        return send(res, 200, { ok: true });
      if (req.method === "GET" && STATIC[url.pathname]) {
        return await serveStatic(res, STATIC[url.pathname]);
      }
      // The window's fonts ship with Crew: no request leaves the PC, and a slow network can't
      // hold the window blank while a font stylesheet loads.
      const font = /^\/fonts\/([A-Za-z0-9-]+\.(woff2|css))$/.exec(url.pathname);
      if (req.method === "GET" && font) {
        return await serveStatic(res, {
          file: new URL(`fonts/${font[1]}`, WEB),
          type: font[2] === "css" ? "text/css; charset=utf-8" : "font/woff2",
          cache: "public, max-age=604800",
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/window/redeem") {
        const { code } = await readJson(req);
        if (!redeemWindowCode(code)) throw new HubError(401, "this window link has expired");
        return send(res, 200, { token: options.token });
      }
      if (req.method === "POST" && url.pathname === "/v1/pair/claim") {
        const { code, name } = await readJson(req);
        return send(res, 200, hub.claimPairing(code, name));
      }
      const auth = authorize(req);
      if (!auth) throw new HubError(401, "missing or wrong token");
      if (req.method === "POST" && url.pathname === "/v1/window/code") {
        localOnly(auth);
        return send(res, 200, { code: newWindowCode() });
      }
      if (req.method === "GET" && url.pathname === "/v1/events")
        return streamEvents(hub, req, res, url, countWindow);
      // `crew open <agent>` with a window already open: switch that window instead of opening another.
      if (req.method === "POST" && url.pathname === "/v1/window/show") {
        localOnly(auth);
        const { agent } = await readJson(req);
        if (agent) hub.assertAgent(String(agent));
        if (!openWindows) return send(res, 200, { shown: false });
        hub.event("window.show", { agent: agent ? String(agent) : null });
        return send(res, 200, { shown: true });
      }

      // Attachments: the raw file is the body (name in x-filename, URI-encoded), up to 25 MB.
      if (req.method === "POST" && url.pathname === "/v1/attachments") {
        if (Number(req.headers["content-length"] ?? 0) > MAX_ATTACHMENT_BYTES) {
          throw new HubError(413, "that file is over 25 MB");
        }
        let name = "file";
        try {
          name = decodeURIComponent(String(req.headers["x-filename"] ?? "file"));
        } catch {
          /* keep "file" */
        }
        try {
          const meta = await saveUpload(req, hub.paths.attachments, {
            name,
            type: String(req.headers["content-type"] ?? ""),
          });
          return send(res, 200, { attachment: hub.addAttachment(meta) });
        } catch (err) {
          if (err.tooBig) throw new HubError(413, "that file is over 25 MB");
          if (err.empty) throw new HubError(400, "that file is empty");
          throw err;
        }
      }
      const file = /^\/v1\/attachments\/([0-9a-f]{16})$/.exec(url.pathname);
      if (req.method === "GET" && file) return sendFile(res, hub.attachment(file[1]));

      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (match && req.method === method) {
          return send(res, 200, await handler(req, match, url, auth));
        }
      }
      throw new HubError(404, "no such route");
    } catch (err) {
      const status = err instanceof HubError ? err.status : 500;
      send(res, status, { error: String(err?.message ?? err) });
    }
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HubError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HubError(400, "body is not JSON");
  }
}

/** Long-poll: return events after `since`, waiting up to `wait` seconds (max 25) for one. */
function pollEvents(hub, since, wait) {
  const ready = hub.store.eventsSince(since);
  // `latest` lets a client start from now instead of reading the whole backlog.
  if (ready.length || !wait) return { events: ready, latest: hub.store.lastSeq() };
  return new Promise((resolvePoll) => {
    const timer = setTimeout(() => done([]), Math.min(wait, 25) * 1000);
    const onEvent = () => done(hub.store.eventsSince(since));
    function done(events) {
      clearTimeout(timer);
      hub.off("event", onEvent);
      resolvePoll({ events, latest: hub.store.lastSeq() });
    }
    hub.on("event", onEvent);
  });
}

/** Server-sent events, resuming after `Last-Event-ID` or `?since=`. */
function streamEvents(hub, req, res, url, countWindow) {
  const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const write = (e) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  // Say hello at once: a client's fetch only resolves when the first bytes arrive.
  res.write(": connected\n\n");
  // since=0 is a client starting fresh (it loads current state itself): no history replay.
  if (since > 0) for (const e of hub.store.eventsSince(since, 500)) write(e);
  // The ping also lets the client notice a dead connection (it reconnects after 40 s of silence).
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  hub.on("event", write);
  const isWindow = url.searchParams.get("window") === "1";
  if (isWindow) countWindow?.(1);
  req.on("close", () => {
    if (isWindow) countWindow?.(-1);
    clearInterval(ping);
    hub.off("event", write);
  });
}
