// Firebase Cloud Messaging (HTTP v1), straight from the hub: no Expo push service, no SDK.
// The hub signs its own Google sign-in (a service-account JWT) with node:crypto, so the
// Firebase key never leaves the PC. The key lives in %LOCALAPPDATA%\crew\firebase-key.json,
// outside the repo and the brain.

import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/**
 * @param {string} keyFile
 * @param {{ fetchFn?: typeof fetch, now?: () => number }} [options]
 * @returns {((pushToken: string, message: { title: string, body: string,
 *   data: Record<string, string>, urgent: boolean, ring?: boolean }) => Promise<{ ok: boolean,
 *   unregistered?: boolean, error?: string }>) | null}  null when there is no key yet
 */
export function fcmSender(keyFile, { fetchFn = fetch, now = Date.now } = {}) {
  if (!existsSync(keyFile)) return null;
  const key = JSON.parse(readFileSync(keyFile, "utf8"));
  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null;

  async function accessToken() {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
      iss: key.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
    const res = await fetchFn(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature.toString("base64url")}`,
      }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(
        `Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`,
      );
    }
    cached = {
      token: body.access_token,
      expiresAt: now() + Number(body.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  }

  return async function send(pushToken, message) {
    try {
      const res = await fetchFn(
        `https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: pushToken,
              notification: { title: message.title, body: message.body },
              data: message.data,
              android: {
                priority: message.urgent ? "high" : "normal",
                notification: {
                  // "calls-v2" rings (the app gives that channel a ringtone); "crew" pings.
                  channel_id: message.ring ? "calls-v2" : "crew",
                  // One notification per agent and kind: a newer one replaces the older.
                  tag: `${message.data.k}-${message.data.agent ?? ""}`,
                },
              },
            },
          }),
        },
      );
      if (res.ok) return { ok: true };
      const body = await res.json().catch(() => ({}));
      const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status;
      return {
        ok: false,
        unregistered: res.status === 404 || code === "UNREGISTERED",
        error: `${res.status} ${code ?? ""}`.trim(),
      };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  };
}
