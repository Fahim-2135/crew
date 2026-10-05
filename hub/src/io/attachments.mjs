// Saving an upload to Documents\Crew\attachments\<date>\ and handing a saved file back. The
// folder is outside Crew's own state, so the agents can read it and file links can open it.

import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { MAX_ATTACHMENT_BYTES, kindOf, safeName } from "../core/attachments.mjs";

/**
 * Stream a request body to disk.
 * @param {import("node:http").IncomingMessage} req
 * @param {string} dir the attachments folder
 * @param {{ name: string, type: string, now?: Date }} file
 */
export async function saveUpload(req, dir, file) {
  const id = randomBytes(8).toString("hex");
  const name = safeName(file.name);
  const now = file.now ?? new Date();
  const two = (n) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const folder = join(dir, day);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id.slice(0, 6)}-${name}`);
  let size = 0;
  const limit = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      if (size > MAX_ATTACHMENT_BYTES) done(Object.assign(new Error("too big"), { tooBig: true }));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(path));
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
  if (!size) {
    rmSync(path, { force: true });
    throw Object.assign(new Error("empty file"), { empty: true });
  }
  const type = String(file.type || "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return { id, name, type, size, path, kind: kindOf(type), at: now.getTime() };
}

/**
 * Send a saved file. Images show inline; anything else downloads, so a page never runs it.
 * @param {import("node:http").ServerResponse} res
 * @param {{ name: string, type: string, path: string }} meta
 */
export function sendFile(res, meta) {
  const size = statSync(meta.path).size;
  const inline = kindOf(meta.type) === "image";
  res.writeHead(200, {
    "content-type": inline ? meta.type : "application/octet-stream",
    "content-length": size,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=86400",
  });
  createReadStream(meta.path).pipe(res);
}
