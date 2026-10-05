// Links in messages: opening a file an agent made on the PC, and showing its text on the phone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPath, openAction, previewable } from "../src/core/files.mjs";
import { openOnPc, openUrl, readPreview } from "../src/io/files.mjs";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { testConfig } from "./team-config.mjs";

test("web links open in the default browser (Chrome), never anything but http(s)", () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push([cmd, args]);
    return { unref() {} };
  };
  assert.equal(
    openUrl("https://claude.ai/artifact/WXxaEEVZRJhsWWTu3C6R7W", { spawnFn }).url,
    "https://claude.ai/artifact/WXxaEEVZRJhsWWTu3C6R7W",
  );
  assert.deepEqual(calls[0], [
    "explorer.exe",
    ['"https://claude.ai/artifact/WXxaEEVZRJhsWWTu3C6R7W"'],
  ]);
  openUrl('https://x.org/a"b c', { spawnFn });
  assert.deepEqual(calls[1][1], ['"https://x.org/a%22b%20c"'], "no quote survives");
  for (const bad of ["javascript:alert(1)", "file:///C:/x.bat", "C:/x.md", ""])
    assert.throws(() => openUrl(bad, { spawnFn }), /not a web link/, bad);
  assert.equal(calls.length, 2);
});

test("on a Mac, files and links open with `open` (Finder shows anything that could run)", () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push([cmd, args]);
    return { unref() {} };
  };
  openUrl("https://example.com/a", { spawnFn, platform: "darwin" });
  assert.deepEqual(calls[0], ["open", ["https://example.com/a"]]);
  const root = mkdtempSync(join(tmpdir(), "crew-mac-"));
  try {
    writeFileSync(join(root, "notes.md"), "hi");
    writeFileSync(join(root, "run.sh"), "echo hi");
    openOnPc(join(root, "notes.md"), { spawnFn, platform: "darwin" });
    openOnPc(join(root, "run.sh"), { spawnFn, platform: "darwin" });
    assert.deepEqual(calls[1], ["open", [join(root, "notes.md")]]);
    assert.deepEqual(calls[2], ["open", ["-R", join(root, "run.sh")]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only full paths that aren't secrets or Crew's own state", () => {
  assert.match(checkPath("E:/social/outputs/post.md"), /post\.md$/);
  for (const bad of ["", "relative/post.md", "E:/x\0y"])
    assert.throws(() => checkPath(bad), /full path/);
  for (const secret of [
    "C:/proj/.env",
    "C:/proj/.env.local",
    "C:/Users/me/AppData/Local/crew/local-token",
    "C:/keys/firebase-key.json",
    "C:/app/google-services.json",
    "C:/Users/me/.ssh/id_ed25519",
    "C:/certs/server.pem",
    "D:/notes/my-passwords.txt",
  ]) {
    assert.throws(() => checkPath(secret), /secret/, secret);
  }
  assert.throws(
    () =>
      checkPath("C:/Users/me/AppData/Local/crew/crew.db", {
        crewHome: "C:/Users/me/AppData/Local/crew",
      }),
    /Crew's own state/,
  );
});

test("documents open in their app; anything that could run is only shown in Explorer", () => {
  assert.equal(openAction("E:/a/post.md", { isDirectory: false }), "open");
  assert.equal(openAction("E:/a/clip.mp4", { isDirectory: false }), "open");
  assert.equal(openAction("E:/a", { isDirectory: true }), "folder");
  for (const p of [
    "E:/a/setup.exe",
    "E:/a/run.bat",
    "E:/a/x.ps1",
    "E:/a/x.js",
    "E:/a/x.lnk",
    "E:/a/noext",
  ])
    assert.equal(openAction(p, { isDirectory: false }), "reveal", p);
  assert.ok(previewable("E:/a/post.md") && previewable("E:/a/app.tsx"));
  assert.ok(!previewable("E:/a/clip.mp4"));
});

test("opening goes through Explorer with the path as one quoted argument", () => {
  const root = mkdtempSync(join(tmpdir(), "crew-files-"));
  try {
    writeFileSync(join(root, "post, v2.md"), "# Post\nHello");
    writeFileSync(join(root, "tool.bat"), "echo hi");
    writeFileSync(join(root, "bin.txt"), Buffer.from([65, 0, 66]));
    mkdirSync(join(root, "folder"));
    const calls = [];
    const spawnFn = (cmd, args, opts) => {
      calls.push([cmd, args, opts.windowsVerbatimArguments]);
      return { unref() {} };
    };
    assert.equal(openOnPc(join(root, "post, v2.md"), { spawnFn }).action, "open");
    assert.equal(openOnPc(join(root, "tool.bat"), { spawnFn }).action, "reveal");
    assert.equal(openOnPc(join(root, "folder"), { spawnFn }).action, "folder");
    assert.deepEqual(calls[0], ["explorer.exe", [`"${join(root, "post, v2.md")}"`], true]);
    assert.deepEqual(calls[1][1], [`/select,"${join(root, "tool.bat")}"`]);
    assert.throws(() => openOnPc(join(root, "missing.md"), { spawnFn }), /no such file/);

    const preview = readPreview(join(root, "post, v2.md"));
    assert.deepEqual([preview.text, preview.cut], ["# Post\nHello", false]);
    assert.throws(() => readPreview(join(root, "bin.txt")), /isn't a text file/);
    assert.throws(() => readPreview(join(root, "tool.bat")), /can't show/);
    assert.throws(() => readPreview(join(root, "folder")), /folder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hub turns refusals into clear errors", () => {
  const store = new Store(":memory:");
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain: "C:/brain", agentsDir: "C:/agents", runs: tmpdir(), home: "C:/crewhome" },
    bin: "none",
    runTurn: () => {
      throw new Error("no runs here");
    },
    sessions: () => [],
    openPath: (path, options) => {
      checkPath(path, options);
      if (path.endsWith("gone.md")) throw new Error("no such file or folder");
      return { ok: true, path };
    },
    readPreview: (path, options) => ({ path: checkPath(path, options), text: "hi" }),
  });
  hub.stop();
  try {
    assert.equal(hub.openPath("E:/a/post.md").ok, true);
    assert.throws(
      () => hub.openPath("E:/a/gone.md"),
      (e) => e.status === 404,
    );
    assert.throws(
      () => hub.openPath("C:/crewhome/crew.db"),
      (e) => e.status === 400,
    );
    assert.throws(() => hub.filePreview("C:/x/.env"), /secret/);
    assert.equal(hub.filePreview("E:/a/post.md").text, "hi");
  } finally {
    store.close();
  }
});

test("the agent browser runs isolated per run, headless, with the saved logins", async () => {
  const { browserPaths, mcpEntry } = await import("../src/io/browser.mjs");
  const paths = browserPaths("C:/crewhome");
  const { args } = mcpEntry(paths, "154");
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.ok(args.includes("--isolated") && args.includes("--headless"));
  assert.equal(flag("--storage-state"), join("C:/crewhome", "browser", "state.json"));
  assert.equal(flag("--browser"), "chrome");
  assert.match(flag("--user-agent"), /Chrome\/154\.0\.0\.0/);
  assert.doesNotMatch(flag("--user-agent"), /Headless/);
  // The saved logins are Crew's own state: file links never open or show them.
  assert.throws(() => checkPath(paths.state, { crewHome: "C:/crewhome" }), /Crew's own state/);
});

test("desktop notifications: a Windows toast or a macOS banner, text escaped", async () => {
  const { notifyDesktop } = await import("../src/io/notify.mjs");
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push([cmd, args]);
    return { on() {}, unref() {} };
  };
  assert.equal(
    notifyDesktop(
      { title: "Writer needs your OK", body: 'Post "<b>hi</b>" & go' },
      { spawnFn, platform: "win32" },
    ),
    true,
  );
  const script = Buffer.from(calls[0][1].at(-1), "base64").toString("utf16le");
  assert.match(script, /Writer needs your OK/);
  assert.match(script, /Post &quot;&lt;b&gt;hi&lt;\/b&gt;&quot; &amp; go/);
  notifyDesktop({ title: "T", body: 'say "hi"' }, { spawnFn, platform: "darwin" });
  assert.deepEqual(calls[1], [
    "osascript",
    ["-e", 'display notification "say \\"hi\\"" with title "T" sound name "Glass"'],
  ]);
  assert.equal(notifyDesktop({ title: "T", body: "b" }, { spawnFn, platform: "linux" }), false);
});
