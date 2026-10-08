// A task the plan's usage limit cut off starts again 5 minutes after the limit resets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "../src/io/store.mjs";
import { Hub } from "../src/hub.mjs";
import { runTurn, killTree } from "../src/io/claude.mjs";
import { testConfig } from "./team-config.mjs";
import { AFTER_RESET_MS, UNKNOWN_RESET_MS, resumeAt, resumePrompt } from "../src/core/resume.mjs";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

test("5 minutes after the reset, or an hour on when the reset time is unknown", () => {
  assert.equal(
    resumeAt({ which: "five-hour", until: 10_000_000 }, 1_000),
    10_000_000 + AFTER_RESET_MS,
  );
  assert.equal(resumeAt(null, 1_000), 1_000 + UNKNOWN_RESET_MS + AFTER_RESET_MS);
  assert.match(
    resumePrompt("make the Praxis video"),
    /Carry on where you left off[\s\S]*make the Praxis video/,
  );
});

async function settled(hub) {
  const busy = () => hub.store.jobsWithStatus("running").length;
  let quiet = 0;
  while (quiet < 3) {
    await new Promise((r) => setTimeout(r, 60));
    quiet = busy() ? 0 : quiet + 1;
  }
}

test("a task stopped by the limit is queued again for after the reset, and runs then", async () => {
  const root = mkdtempSync(join(tmpdir(), "crew-resume-"));
  const brain = join(root, "brain");
  const agentsDir = join(root, "agents");
  const runs = join(root, "runs");
  for (const dir of [brain, agentsDir, runs]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agentsDir, "social.md"), "---\nname: social\n---\n\nYou are social.\n");
  const clock = { now: Date.now() };
  const store = new Store(":memory:");
  const hub = new Hub({
    config: { ...testConfig(), quiet: [] },
    store,
    paths: { brain, agentsDir, runs, crewGuard: "g", gateHook: "g" },
    bin: FAKE,
    runTurn,
    sessions: () => [],
    killTree,
    afterWrite: () => {},
    now: () => clock.now,
    utcOffsetMinutes: () => 360,
  });
  try {
    hub.start();
    // The run reports the five-hour window as full, resetting in 2 hours (fake-claude LIMITHIT).
    hub.send("social", "LIMITHIT make the Praxis video");
    await settled(hub);
    const again = store.queuedJobs()[0];
    assert.ok(again, "queued again");
    const expected = clock.now + 2 * 3600_000 + AFTER_RESET_MS;
    assert.ok(Math.abs(again.notBefore - expected) < 5000, "5 minutes after the reset");
    assert.match(again.prompt, /Carry on where you left off/);
    assert.match(hub.messages("social").pop().text, /picks this up again at/);

    // Not before its time...
    hub.tick();
    await settled(hub);
    assert.equal(store.job(again.id).status, "queued");
    // ...then it runs, in the same conversation.
    clock.now = again.notBefore + 1000;
    store.set("usage", { fiveHour: 0.02, sevenDay: 0.5, resetsAt: null, at: clock.now });
    hub.tick();
    await settled(hub);
    assert.equal(store.job(again.id).status, "done");
  } finally {
    await hub.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
