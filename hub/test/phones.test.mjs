// Phones: pairing, phone keys, what a phone may do, and which events reach it as a push.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { createApi } from "../src/io/http.mjs";
import { pushFor } from "../src/core/push.mjs";
import { fcmSender } from "../src/io/fcm.mjs";
import { testConfig } from "./team-config.mjs";

const TOKEN = "t".repeat(64);
const REMOTE = "laptop.tail0000.ts.net";

function setup(now = () => 1_000_000) {
  const store = new Store(":memory:");
  const pushes = [];
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain: tmpdir(), agentsDir: tmpdir(), runs: tmpdir(), crewGuard: "guard.mjs" },
    bin: "none",
    runTurn: () => {
      throw new Error("no runs in these tests");
    },
    sessions: () => [],
    now,
    push: async (pushToken, message) => {
      pushes.push({ pushToken, message });
      return pushToken === "gone" ? { ok: false, unregistered: true, error: "404" } : { ok: true };
    },
  });
  hub.stop(); // no job ever starts: these tests are about the API around jobs
  return { store, hub, pushes };
}

async function serve(hub) {
  const probe = createApi(hub, { port: 0, token: TOKEN });
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  probe.close();
  const api = createApi(hub, { port, token: TOKEN, remoteHost: REMOTE });
  await new Promise((r) => api.listen(port, "127.0.0.1", r));
  const call = (path, { key, body, method } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /** fetch() drops a custom Host header, so the host check is tested with a raw request. */
  const statusWithHost = (path, host, key) =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, headers: { host, authorization: `Bearer ${key}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
  return { api, call, statusWithHost };
}

test("a pairing code pairs one phone once, and the hub keeps only a hash of its key", async () => {
  let clock = 1_000_000;
  const { store, hub } = setup(() => clock);
  const { code } = hub.startPairing();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);

  assert.throws(() => hub.claimPairing("WRONG123", "moto"), /wrong pairing code/);
  const { deviceId, token } = hub.claimPairing(`${code.slice(0, 4)} ${code.slice(4)}`, "moto");
  assert.ok(token.length >= 40);
  assert.equal(hub.deviceForKey(token).id, deviceId);
  assert.equal(JSON.stringify(store.devices()).includes(token), false);
  assert.throws(() => hub.claimPairing(code, "again"), /no pairing code is open/);

  // Expired codes and too many wrong guesses both close the code.
  const late = hub.startPairing();
  clock += 5 * 60_000 + 1;
  assert.throws(() => hub.claimPairing(late.code, "x"), /no pairing code is open/);
  const guessed = hub.startPairing();
  for (let i = 0; i < 5; i++) assert.throws(() => hub.claimPairing("AAAAAAAA", "x"));
  assert.throws(() => hub.claimPairing(guessed.code, "x"), /no pairing code is open/);
});

test("over the API a phone chats and decides, but only the PC pairs, lists or opens windows", async () => {
  const { hub } = setup();
  const { api, call, statusWithHost } = await serve(hub);
  try {
    // Pairing starts on the PC and tells the phone where the hub is.
    assert.equal((await call("/v1/pair/start", { body: {} })).status, 401);
    const started = await (await call("/v1/pair/start", { key: TOKEN, body: {} })).json();
    assert.equal(started.hubUrl, `https://${REMOTE}`);

    const claim = await call("/v1/pair/claim", {
      body: { code: started.code, name: "moto g56" },
    });
    assert.equal(claim.status, 200);
    const { token: phone } = await claim.json();

    assert.equal((await call("/v1/agents", { key: phone })).status, 200);
    const me = await (await call("/v1/devices/me", { key: phone })).json();
    assert.equal(me.device.name, "moto g56");

    const sent = await (
      await call("/v1/threads/social/messages", { key: phone, body: { text: "hi from the bus" } })
    ).json();
    assert.equal(hub.job(sent.job.id).origin, "phone");
    const fromPc = await (
      await call("/v1/threads/social/messages", { key: TOKEN, body: { text: "hi from the desk" } })
    ).json();
    assert.equal(hub.job(fromPc.job.id).origin, "pc");

    for (const [path, body] of [
      ["/v1/pair/start", {}],
      ["/v1/window/code", {}],
    ]) {
      assert.equal((await call(path, { key: phone, body })).status, 403, path);
    }
    assert.equal((await call("/v1/devices", { key: phone })).status, 403);

    assert.equal(
      (await call("/v1/devices/me/push", { key: phone, body: { pushToken: "fcm-1" } })).status,
      200,
    );
    const { devices } = await (await call("/v1/devices", { key: TOKEN })).json();
    assert.equal(devices[0].push, true);

    // A phone can cut itself off; after that its key opens nothing.
    assert.equal((await call("/v1/devices/me/unpair", { key: phone, body: {} })).status, 200);
    assert.equal((await call("/v1/agents", { key: phone })).status, 401);
    assert.equal(await statusWithHost("/v1/agents", "evil.example", TOKEN), 421);
    assert.equal(await statusWithHost("/v1/agents", REMOTE, TOKEN), 200);
  } finally {
    api.close();
  }
});

test("approvals and replies to phone messages reach the phone; PC chat does not", async () => {
  const { store, hub, pushes } = setup();
  const { code } = hub.startPairing();
  const { deviceId } = hub.claimPairing(code, "moto");
  hub.setPushToken(deviceId, "fcm-1");

  const phoneJob = store.addJob({
    agent: "growth",
    kind: "chat",
    priority: 0,
    prompt: "x",
    createdAt: 1,
    origin: "phone",
  });
  const pcJob = store.addJob({
    agent: "ops",
    kind: "chat",
    priority: 0,
    prompt: "y",
    createdAt: 1,
  });
  hub.event("job.done", { jobId: phoneJob.id, agent: "growth", error: null });
  hub.event("job.done", { jobId: pcJob.id, agent: "ops", error: null });
  hub.event("approval.requested", {
    code: "A-1234",
    agent: "engineering",
    summary: "Push the fix to main with the secret key",
    tainted: false,
  });
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(
    pushes.map((p) => p.message.title),
    ["Growth replied", "Engineering needs you"],
  );
  // What an approval would do never leaves the PC in a notification.
  assert.equal(JSON.stringify(pushes).includes("secret"), false);

  // A token Google says is gone is dropped.
  hub.setPushToken(deviceId, "gone");
  hub.event("report", { date: "2026-10-04", lines: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.device(deviceId).pushToken, null);
  assert.match(store.get("push:lastError").error, /404/);
});

test("pushFor stays quiet for events that don't concern the phone", () => {
  assert.equal(pushFor({ type: "job.started", data: { agent: "ops" } }), null);
  assert.equal(pushFor({ type: "budget", data: {} }), null);
  assert.equal(
    pushFor({ type: "job.done", data: { agent: "ops", jobId: 1 } }, { job: { origin: "pc" } }),
    null,
  );
  const tainted = pushFor({
    type: "approval.requested",
    data: { agent: "ops", code: "A-1", tainted: true },
  });
  assert.match(tainted.body, /email/);
  assert.equal(tainted.urgent, true);
});

test("the FCM sender signs its own Google sign-in and sends a high-priority message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-fcm-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyFile = join(dir, "firebase-key.json");
  writeFileSync(
    keyFile,
    JSON.stringify({
      project_id: "crew-test",
      client_email: "hub@crew-test.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.example/token",
    }),
  );
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url === "https://oauth2.example/token") {
      return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    }
    if (init.body.includes('"token":"dead"')) {
      return Response.json(
        { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
        { status: 404 },
      );
    }
    return Response.json({ name: "projects/crew-test/messages/1" });
  };
  try {
    assert.equal(fcmSender(join(dir, "missing.json")), null);
    const send = fcmSender(keyFile, { fetchFn, now: () => 1_700_000_000_000 });
    const message = {
      title: "Ops needs you",
      body: "Tap",
      data: { k: "approval", agent: "ops" },
      urgent: true,
    };
    assert.deepEqual(await send("fcm-1", message), { ok: true });
    assert.equal((await send("dead", message)).unregistered, true);

    // One Google sign-in, reused; its JWT verifies against the service account's key.
    const signIns = calls.filter((c) => c.url === "https://oauth2.example/token");
    assert.equal(signIns.length, 1);
    const jwt = new URLSearchParams(signIns[0].init.body).get("assertion");
    const [h, p, sig] = jwt.split(".");
    assert.ok(
      createVerify("RSA-SHA256")
        .update(`${h}.${p}`)
        .verify(publicKey, Buffer.from(sig, "base64url")),
    );
    assert.equal(
      JSON.parse(Buffer.from(p, "base64url")).iss,
      "hub@crew-test.iam.gserviceaccount.com",
    );

    const sent = JSON.parse(calls[1].init.body).message;
    assert.equal(calls[1].url, "https://fcm.googleapis.com/v1/projects/crew-test/messages:send");
    assert.equal(calls[1].init.headers.authorization, "Bearer ya29.test");
    assert.equal(sent.token, "fcm-1");
    assert.equal(sent.android.priority, "high");
    assert.equal(sent.android.notification.channel_id, "crew");

    // Ringing goes to the calls channel the app gives a ringtone.
    await send("fcm-1", { ...message, ring: true });
    const rang = JSON.parse(calls.at(-1).init.body).message;
    assert.equal(rang.android.notification.channel_id, "calls-v2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
