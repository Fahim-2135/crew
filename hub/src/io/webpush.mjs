// Notifications for Crew's phone browser app (Web Push), with no dependencies: the message is
// encrypted for the one browser that subscribed (RFC 8291, aes128gcm) and the request is signed
// with Crew's own VAPID key (RFC 8292), so only that phone can read it and only this hub can send.
//
// Keys live in %LOCALAPPDATA%\crew\vapid.json, made on first use. A browser's subscription is
// stored as the device's push token, prefixed "webpush:".

import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WEBPUSH_PREFIX = "webpush:";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (text) => Buffer.from(String(text), "base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** Crew's VAPID key pair: { publicKey (65-byte point, base64url), privateKey (32 bytes, base64url) }. */
export function vapidKeys(home) {
  const file = join(home, "vapid.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  writeFileSync(file, JSON.stringify(keys));
  return keys;
}

/** The VAPID private key as a KeyObject (from its raw 32 bytes and public point). */
function signingKey(keys) {
  const pub = fromB64u(keys.publicKey);
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: "jwk",
  });
}

/** `Authorization: vapid t=<JWT>, k=<public key>` for one push service. */
export function vapidHeader(keys, endpoint, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(
    JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }),
  );
  const input = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: signingKey(keys),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${input}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypt one message for one browser (RFC 8291, a single aes128gcm record).
 * @param {Buffer} plaintext
 * @param {{ p256dh: string, auth: string }} keys the subscription's keys
 */
export function encrypt(plaintext, keys, salt = randomBytes(16), server = null) {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  const ecdh = server ?? createECDH("prime256v1");
  if (!server) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    uaPublic,
    asPublic,
    Buffer.from([1]),
  ]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The last (and only) record ends with the padding delimiter 0x02.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/**
 * A sender with the same shape as the FCM one: (subscription JSON, message) → { ok, unregistered, error }.
 * @param {{ keys: object, subject: string, fetchFn?: typeof fetch }} options
 */
export function webPushSender({ keys, subject, fetchFn = fetch }) {
  return async (subscriptionJson, message) => {
    let sub;
    try {
      sub = JSON.parse(subscriptionJson);
    } catch {
      return { ok: false, unregistered: true, error: "bad subscription" };
    }
    // What the phone shows; the app opens the right chat from `data`.
    const payload = Buffer.from(
      JSON.stringify({ title: message.title, body: message.body, data: message.data ?? {} }),
    );
    try {
      const res = await fetchFn(sub.endpoint, {
        method: "POST",
        headers: {
          authorization: vapidHeader(keys, sub.endpoint, subject),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(message.urgent ? 3600 : 86400),
          urgency: message.urgent ? "high" : "normal",
        },
        body: encrypt(payload, sub.keys),
      });
      if (res.status === 404 || res.status === 410) {
        return { ok: false, unregistered: true, error: `gone (${res.status})` };
      }
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  };
}
