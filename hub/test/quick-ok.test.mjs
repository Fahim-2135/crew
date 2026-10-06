import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { askOwner } from "../src/io/quick-ok.mjs";

/** A stand-in hub (one pending quick OK, answered on the second look) and claude-face. */
function servers({ status = "pending" } = {}) {
  const gateBodies = [];
  const faceStates = [];
  let looks = 0;
  const read = (req) =>
    new Promise((done) => {
      let raw = "";
      req.on("data", (c) => (raw += c)).on("end", () => done(raw ? JSON.parse(raw) : {}));
    });
  const hub = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/gate") {
      gateBodies.push(await read(req));
      return res.end(JSON.stringify({ approval: { id: "a1", status } }));
    }
    looks += 1;
    res.end(JSON.stringify({ approval: { id: "a1", status: looks > 1 ? "approved" : "pending" } }));
  });
  const face = createServer(async (req, res) => {
    faceStates.push(await read(req));
    res.end("{}");
  });
  const listen = (s) =>
    new Promise((done) => s.listen(0, "127.0.0.1", () => done(s.address().port)));
  return { hub, face, listen, gateBodies, faceStates };
}

test("a quick OK shows the session as asking on claude-face until it's answered", async (t) => {
  const s = servers();
  const hubPort = await s.listen(s.hub);
  const facePort = await s.listen(s.face);
  t.after(() => (s.hub.close(), s.face.close()));
  const env = {
    CREW_PORT: String(hubPort),
    CREW_JOB: "7",
    CREW_AGENT: "social",
    CREW_CLI: "C:/crew.mjs",
  };
  const answer = await askOwner(
    { tool: "x", summary: "Post", reason: "r", face: { session_id: "s1", cwd: "C:/b" } },
    env,
    { faceUrl: `http://127.0.0.1:${facePort}/state` },
  );
  assert.equal(answer.allow, true);
  assert.deepEqual(
    s.faceStates.map((b) => [b.session_id, b.state, b.crew?.agent]),
    [
      ["s1", "asking", "social"],
      ["s1", "working", "social"],
    ],
  );
  // The session details stay out of the hub's request.
  assert.equal(s.gateBodies[0].face, undefined);
  assert.equal(s.gateBodies[0].jobId, 7);
});

test("a quick OK already allowed for the task doesn't flash the face", async (t) => {
  const s = servers({ status: "approved" });
  const hubPort = await s.listen(s.hub);
  const facePort = await s.listen(s.face);
  t.after(() => (s.hub.close(), s.face.close()));
  const answer = await askOwner(
    { tool: "x", summary: "Follow", reason: "r", face: { session_id: "s1" } },
    { CREW_PORT: String(hubPort), CREW_JOB: "7" },
    { faceUrl: `http://127.0.0.1:${facePort}/state` },
  );
  assert.equal(answer.allow, true);
  assert.deepEqual(s.faceStates, []);
});

test("no claude-face running: the quick OK still works", async (t) => {
  const s = servers();
  const hubPort = await s.listen(s.hub);
  t.after(() => s.hub.close());
  const answer = await askOwner(
    { tool: "x", summary: "Post", reason: "r", face: { session_id: "s1" } },
    { CREW_PORT: String(hubPort), CREW_JOB: "7" },
    { faceUrl: "http://127.0.0.1:9/state" },
  );
  assert.equal(answer.allow, true);
});
