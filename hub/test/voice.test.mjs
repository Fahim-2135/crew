// Voice calls: streamed replies become spoken sentences, and "call me back" rings the phone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseStreamLine } from "../src/core/stream.mjs";
import { createSplitter, speakable, voiceNote } from "../src/core/speech.mjs";
import { pushFor } from "../src/core/push.mjs";
import { buildArgs } from "../src/core/policy.mjs";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { runTurn, killTree } from "../src/io/claude.mjs";
import { testConfig } from "./team-config.mjs";

const FIXTURE = fileURLToPath(
  new URL("../../spikes/fixtures/partial-messages.jsonl", import.meta.url),
);
const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

test("partial messages from a real run parse into text pieces that add up to the reply", (t) => {
  // The recorded run stays private (spikes/fixtures is never committed): skip where it's absent.
  if (!existsSync(FIXTURE)) return t.skip("no recorded run here");
  const events = readFileSync(FIXTURE, "utf8").trim().split("\n").flatMap(parseStreamLine);
  const streamed = events
    .filter((e) => e.kind === "delta")
    .map((e) => e.text)
    .join("");
  const final = events.filter((e) => e.kind === "text").map((e) => e.text);
  assert.ok(streamed.length > 20);
  assert.ok(final.includes(streamed), "the pieces make the final text");
  assert.ok(events.some((e) => e.kind === "blockEnd"));
});

test("the splitter gives whole sentences as they complete, and joins tiny ones", () => {
  const s = createSplitter();
  assert.deepEqual(s.push("Ok. The build "), []);
  assert.deepEqual(s.push("passed on 3.5 seconds. Next I"), [
    "Ok. The build passed on 3.5 seconds.",
  ]);
  assert.deepEqual(s.push(" will check **the** `logs`"), []);
  assert.deepEqual(s.flush(), ["Next I will check the logs"]);
  assert.deepEqual(s.flush(), []);
});

test("speakable drops markdown that sounds wrong aloud", () => {
  assert.equal(
    speakable("## Plan\n- **Fix** the [paywall](http://x)\n```js\ncode()\n```\nThen `ship`."),
    "Plan Fix the paywall Then ship.",
  );
});

test("call runs stream; chat runs don't", () => {
  const base = {
    agent: "ops",
    agentsPath: "a",
    settingsPath: "s",
    tools: ["Read"],
    model: "sonnet",
    appendPrompt: "",
    sessionId: "x",
  };
  assert.ok(buildArgs({ ...base, partial: true }).includes("--include-partial-messages"));
  assert.ok(!buildArgs(base).includes("--include-partial-messages"));
});

test("ringing: approvals ring outside quiet hours; a call-back always rings", () => {
  const approval = { type: "approval.requested", data: { agent: "ops", code: "A-1" } };
  assert.equal(pushFor(approval).ring, true);
  assert.equal(pushFor(approval, { quiet: true }).ring, false);

  const done = { type: "job.done", data: { agent: "growth", jobId: 7 } };
  const call = { kind: "call", origin: "phone" };
  assert.equal(pushFor(done, { job: call }), null, "a call he stayed on was heard");
  const back = pushFor(done, { job: call, callBack: true, quiet: true });
  assert.equal(back.title, "Growth is calling you back");
  assert.equal(back.ring, true);
  assert.deepEqual(back.data, { k: "call", agent: "growth", jobId: "7", ring: "1" });
});

test("a call job tells the agent it is heard, streams job.say sentences, and can call back", async () => {
  const root = mkdtempSync(join(tmpdir(), "crew-voice-"));
  const brain = join(root, "brain");
  const agentsDir = join(root, "agents");
  const runs = join(root, "runs");
  for (const dir of [brain, agentsDir, runs]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(agentsDir, "ops.md"),
    "---\nname: ops\ndescription: ops\ntools: Read, Write\nmodel: sonnet\n---\nYou are ops.\n",
  );
  const store = new Store(":memory:");
  const pushes = [];
  const hub = new Hub({
    config: testConfig(),
    store,
    paths: { brain, agentsDir, runs, crewGuard: "guard.mjs" },
    bin: FAKE,
    runTurn,
    killTree,
    sessions: () => [],
    push: async (_t, message) => {
      pushes.push(message);
      return { ok: true };
    },
  });
  store.set("usage", { fiveHour: 0.1, sevenDay: 0.1 });
  const { code } = hub.startPairing();
  const { deviceId } = hub.claimPairing(code, "moto");
  hub.setPushToken(deviceId, "fcm-1");
  const said = [];
  hub.on("event", (e) => {
    if (e.type === "job.say") said.push(e.data.text);
  });
  try {
    hub.start();
    const job = hub.send("ops", "Is AdMob verified yet? Tell me in one line.", {
      kind: "call",
      origin: "phone",
    });
    assert.ok(store.job(job.id).prompt.startsWith(voiceNote()));
    assert.equal(store.messages("ops").at(-1).text, "Is AdMob verified yet? Tell me in one line.");
    assert.deepEqual(hub.callBack(job.id).callBack, true);
    await new Promise((resolve) => {
      const check = (e) => {
        if (e.type === "job.done" || e.type === "job.failed") {
          hub.off("event", check);
          resolve();
        }
      };
      hub.on("event", check);
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(said, ["echo: Is AdMob verified yet?", "Tell me in one line."]);
    assert.equal(pushes.at(-1).title, "Ops is calling you back");
    assert.throws(() => hub.callBack(99), /no such call/);
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
