// What Crew may do with a file or folder an agent linked in a message: open it on the PC, or
// show its text on the phone. Pure rules; io/files.mjs carries them out.
//
// Opening is for looking, never for running: only document types open in their app, and
// anything else (a script, an installer, a shortcut) is shown selected in Explorer instead.
// Secrets (keys, tokens, Crew's own state) are never opened or shown.

import { isAbsolute, normalize, resolve, sep } from "node:path";

/** Files that open in their own app with a click. */
const DOCUMENTS = new Set(
  (
    "md txt log csv tsv json jsonl yml yaml toml xml html htm pdf png jpg jpeg gif webp svg bmp ico " +
    "mp3 wav m4a ogg mp4 mov webm mkv doc docx xls xlsx ppt pptx odt ods odp rtf"
  ).split(" "),
);

/** Files whose text can be shown on the phone. */
const TEXT = new Set(
  (
    "md txt log csv tsv json jsonl yml yaml toml xml html htm css mjs cjs js jsx ts tsx py c h " +
    "cpp java kt swift go rs rb php sh sql"
  ).split(" "),
);

/** The phone shows at most this much of a file. */
export const PREVIEW_BYTES = 200_000;

const SECRET =
  /(^|[\\/])(\.env(\.[^\\/]*)?|[^\\/]*(secret|token|credential|password)[^\\/]*|[^\\/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa)[^\\/]*|firebase-key\.json|google-services\.json|\.npmrc|\.netrc)$/i;

const ext = (path) => /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";

/**
 * A path Crew may touch: absolute, not a secret, not inside Crew's own state folder.
 * @param {unknown} input
 * @param {{ crewHome?: string }} [context]
 * @returns {string} the normalized path
 */
export function checkPath(input, context = {}) {
  const raw = String(input ?? "").trim();
  if (!raw || raw.includes("\0") || !isAbsolute(raw) || !/^[A-Za-z]:[\\/]|^\//.test(raw)) {
    throw new Error("not a full path");
  }
  const path = normalize(resolve(raw));
  if (SECRET.test(path)) throw new Error("that looks like a secret: open it yourself");
  if (context.crewHome) {
    const home = normalize(resolve(context.crewHome)).toLowerCase();
    const p = path.toLowerCase();
    if (p === home || p.startsWith(home.endsWith(sep) ? home : home + sep)) {
      throw new Error("that is Crew's own state: open it yourself");
    }
  }
  return path;
}

/**
 * How to open a path on the PC.
 * @param {string} path a checked path
 * @param {{ isDirectory: boolean }} stat
 * @returns {"folder" | "open" | "reveal"}
 */
export function openAction(path, stat) {
  if (stat.isDirectory) return "folder";
  return DOCUMENTS.has(ext(path)) ? "open" : "reveal";
}

/**
 * Whether the phone may show a file's text.
 * @param {string} path a checked path
 */
export function previewable(path) {
  return TEXT.has(ext(path));
}
