// Attaching files to a message: names on disk, what the agent is told, and the upload route.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { attachmentNote, kindOf, safeName } from "../src/core/attachments.mjs";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { createApi } from "../src/io/http.mjs";
import { testConfig } from "./team-config.mjs";

test("file names are safe on Windows and keep their extension", () => {
  assert.equal(safeName("C:\\Users\\x\\Desktop\\report.pdf"), "report.pdf");
  assert.equal(safeName("../../evil.bat"), "evil.bat");
  assert.equal(safeName('a<b>:"c|?*.png'), "abc.png");
  assert.equal(safeName("CON.txt"), "_CON.txt");
  assert.equal(safeName("  trailing.  "), "trailing");
  assert.equal(safeName(""), "file");
  const long = safeName(`${"x".repeat(200)}.docx`);
  assert.equal(long.length, 80);
  assert.ok(long.endsWith(".docx"));
  assert.equal(kindOf("image/png"), "image");
  assert.equal(kindOf("image/svg+xml"), "file", "SVG can carry script: shown as a file");
  assert.equal(kindOf("application/pdf"), "file");
});

test("the agent is told where each file is", () => {
  const note = attachmentNote([
    {
      name: "shot.png",
      type: "image/png",
      size: 2048,
      path: "C:\\Users\\u\\Documents\\Crew\\attachments\\2026-10-05\\ab12cd-shot.png",
    },
    { name: "plan.pdf", type: "application/pdf", size: 3 * 1024 * 1024, path: "C:/x/plan.pdf" },
  ]);
  assert.match(note, /The user attached 2 files/);
  assert.match(note, /Read tool/);
  assert.match(
    note,
    /- C:\/Users\/u\/Documents\/Crew\/attachments\/2026-10-05\/ab12cd-shot\.png \(shot\.png, image\/png, 2 KB\)/,
  );
  assert.match(note, /plan\.pdf, application\/pdf, 3\.0 MB/);
  assert.equal(attachmentNote([]), "");
});

/** POST raw bytes, like the window and the app do. */
function upload(port, token, body, headers) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/attachments",
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("upload, send with the message, and fetch it back", async () => {
  const root = mkdtempSync(join(tmpdir(), "crew-attach-"));
  const store = new Store(":memory:");
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: {
      brain: "C:/brain",
      agentsDir: "C:/agents",
      runs: root,
      attachments: join(root, "attachments"),
    },
    bin: "none",
    runTurn: () => {
      throw new Error("no runs here");
    },
    sessions: () => [],
  });
  hub.stop();
  const token = "t".repeat(64);
  const probe = createApi(hub, { port: 0, token });
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  probe.close();
  const api = createApi(hub, { port, token });
  await new Promise((r) => api.listen(port, "127.0.0.1", r));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const up = await upload(port, token, png, {
      "content-type": "image/png",
      "x-filename": encodeURIComponent("my screen (1).png"),
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const meta = up.body.attachment;
    assert.match(meta.id, /^[0-9a-f]{16}$/);
    assert.equal(meta.kind, "image");
    assert.equal(meta.name, "my screen (1).png");
    assert.ok(existsSync(meta.path) && meta.path.startsWith(join(root, "attachments")));
    assert.deepEqual(readFileSync(meta.path), png);

    assert.equal((await upload(port, token, "", { "content-type": "text/plain" })).status, 400);
    assert.equal((await upload(port, "wrong".padEnd(64, "x"), "hi", {})).status, 401);

    // A message with a file and no words: the chat shows the file, the agent gets its path.
    const job = hub.send("ops", "", { attachments: [meta.id] });
    assert.match(store.job(job.id).prompt, /The user attached a file/);
    assert.ok(store.job(job.id).prompt.includes(meta.path.replace(/\\/g, "/")));
    const shown = store.messages("ops").at(-1);
    assert.equal(shown.text, "");
    assert.equal(shown.attachments[0].id, meta.id);
    assert.throws(() => hub.send("ops", "hi", { attachments: ["0".repeat(16)] }), /missing/);
    assert.throws(() => hub.send("ops", "  "), /empty/);

    const back = await fetch(`http://127.0.0.1:${port}/v1/attachments/${meta.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(back.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await back.arrayBuffer()), png);
  } finally {
    api.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
