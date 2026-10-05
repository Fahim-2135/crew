// Files the user attaches to a message (an image, a PDF, a document): how they are named on disk,
// how they show in the chat, and what the agent is told. Pure.

import { Owner } from "./owner.mjs";

/** Largest single attachment. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Most attachments on one message. */
export const MAX_PER_MESSAGE = 10;

/** Images the window and the app show inline; everything else is a file chip. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * A file name safe on Windows: no folders, no reserved characters, no trailing dots or spaces,
 * at most 80 characters, keeping the extension.
 * @param {unknown} input
 */
export function safeName(input) {
  let name = String(input ?? "")
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex -- control characters are what this strips
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `_${name}`;
  if (!name || /^\.+$/.test(name)) name = "file";
  if (name.length > 80) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, 80 - ext.length) + ext;
  }
  return name;
}

/** "image" for pictures shown inline, "file" for the rest. */
export function kindOf(type) {
  return IMAGE_TYPES.has(String(type ?? "").toLowerCase()) ? "image" : "file";
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * What the agent reads after the user's words: where each file is, so it opens them itself.
 * @param {Array<{ name: string, type: string, size: number, path: string }>} files
 */
export function attachmentNote(files) {
  if (!files.length) return "";
  const lines = files.map(
    (f) =>
      `- ${f.path.replace(/\\/g, "/")} (${f.name}, ${f.type || "unknown type"}, ${formatSize(f.size)})`,
  );
  return [
    `${Owner()} attached ${files.length === 1 ? "a file" : `${files.length} files`}. Open ${files.length === 1 ? "it" : "each"} with the Read tool before you answer (it reads images and PDFs too; use the shell for other formats):`,
    ...lines,
  ].join("\n");
}
