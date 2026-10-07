// The phone browser app: Web Push encryption and signing, notifications reaching it, and the
// home-Wi-Fi address that only takes phone keys.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { createApi } from "../src/io/http.mjs";
import { testConfig } from "./team-config.mjs";
import {
  encrypt,
  vapidHeader,
  vapidKeys,
  webPushSender,
  WEBPUSH_PREFIX,
} from "../src/io/webpush.mjs";

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** What the browser does (RFC 8291): decrypt one aes128gcm record with its private key. */
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(
    prkKey,
    Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]),
  );
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]);
  assert.equal(plain.at(-1), 2, "last-record padding delimiter");
  return plain.subarray(0, plain.length - 1).toString();
}

function browser() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  return {
    ua,
    auth,
    keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
  };
}

test("a message is readable only by the browser that subscribed", () => {
  const b = browser();
  const body = encrypt(Buffer.from('{"title":"Social needs you"}'), b.keys);
  assert.equal(decrypt(body, b.ua, b.auth), '{"title":"Social needs you"}');
  const other = browser();
  assert.throws(() => decrypt(body, other.ua, other.auth));
});

test("the request is signed with Crew's VAPID key for that push service", () => {
  const home = mkdtempSync(join(tmpdir(), "crew-vapid-"));
  try {
    const keys = vapidKeys(home);
    assert.deepEqual(vapidKeys(home), keys, "kept once made");
    const header = vapidHeader(keys, "https://fcm.googleapis.com/fcm/send/abc", "https://x", 0);
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    assert.equal(k, keys.publicKey);
    const [h, c, sig] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(c, "base64url"));
    assert.equal(claims.aud, "https://fcm.googleapis.com");
    const pub = Buffer.from(keys.publicKey, "base64url");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: pub.subarray(1, 33).toString("base64url"),
        y: pub.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    assert.equal(
      verify(
        "sha256",
        Buffer.from(`${h}.${c}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(sig, "base64url"),
      ),
      true,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the sender posts an encrypted message, and a gone subscription says so", async () => {
  const home = mkdtempSync(join(tmpdir(), "crew-vapid-"));
  try {
    const b = browser();
    const sent = [];
    const send = webPushSender({
      keys: vapidKeys(home),
      subject: "https://x",
      fetchFn: async (url, init) => {
        sent.push({ url, init });
        return { ok: url.endsWith("/ok"), status: url.endsWith("/ok") ? 201 : 410 };
      },
    });
    const sub = (end) => JSON.stringify({ endpoint: `https://push.example/${end}`, keys: b.keys });
    assert.deepEqual(
      await send(sub("ok"), { title: "Ops checked something", body: "x", urgent: true }),
      { ok: true },
    );
    assert.equal(sent[0].init.headers["content-encoding"], "aes128gcm");
    assert.equal(sent[0].init.headers.urgency, "high");
    assert.match(decrypt(sent[0].init.body, b.ua, b.auth), /Ops checked something/);
    assert.equal((await send(sub("gone"), { title: "t", body: "b" })).unregistered, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("notifications go to browser phones by Web Push and to the Android app by Firebase", async () => {
  const store = new Store(":memory:");
  const fcm = [];
  const web = [];
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain: tmpdir(), agentsDir: tmpdir(), runs: tmpdir(), crewGuard: "g" },
    bin: "none",
    runTurn: () => {
      throw new Error("no runs");
    },
    sessions: () => [],
    push: async (token) => (fcm.push(token), { ok: true }),
    webPush: async (sub) => (web.push(JSON.parse(sub).endpoint), { ok: true }),
  });
  hub.stop();
  store.addDevice({ id: "a", name: "Android", tokenHash: "h1", createdAt: 1 });
  store.updateDevice("a", { pushToken: "fcm-token" });
  store.addDevice({ id: "b", name: "Phone browser", tokenHash: "h2", createdAt: 1 });
  const b = browser();
  hub.setWebPush("b", { endpoint: "https://push.example/sub", keys: b.keys });
  assert.ok(store.device("b").pushToken.startsWith(WEBPUSH_PREFIX));
  assert.throws(() => hub.setWebPush("b", { endpoint: "http://insecure" }), /bad subscription/);

  hub.event("check.found", { agent: "ops", jobId: 1, text: "The booking was cancelled." });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fcm, ["fcm-token"]);
  assert.deepEqual(web, ["https://push.example/sub"]);
  store.close();
});

test("the home-Wi-Fi address takes phone keys only, never the PC's key", async () => {
  const store = new Store(":memory:");
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain: tmpdir(), agentsDir: tmpdir(), runs: tmpdir(), crewGuard: "g" },
    bin: "none",
    runTurn: () => {
      throw new Error("no runs");
    },
    sessions: () => [],
  });
  hub.stop();
  const TOKEN = "t".repeat(64);
  const probe = createApi(hub, { port: 0, token: TOKEN });
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  probe.close();
  const lan = createApi(hub, {
    port,
    token: TOKEN,
    lan: true,
    extraHosts: [`192.168.1.5:${port}`],
  });
  await new Promise((r) => lan.listen(port, "127.0.0.1", r));
  const call = (path, key, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: { host: `192.168.1.5:${port}`, authorization: `Bearer ${key}` },
        },
        (res) => (res.resume(), resolve(res.statusCode)),
      );
      req.on("error", reject);
      req.end(method === "POST" ? "{}" : undefined);
    });
  try {
    assert.equal(await call("/v1/agents", TOKEN), 401, "the PC's key is refused");
    assert.equal(await call("/v1/window/redeem", TOKEN, "POST"), 403);
    assert.equal(await call("/", ""), 200, "the page itself loads");
    const { code } = hub.startPairing();
    const { token } = hub.claimPairing(code, "Phone browser");
    assert.equal(await call("/v1/agents", token), 200, "a phone key works");
  } finally {
    lan.close();
    store.close();
  }
});
