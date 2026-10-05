import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLinks } from "./links.mjs";

const kinds = (text) => splitLinks(text).map((p) => [p.kind, p.url ?? p.path ?? p.text]);

test("web links are found, without the sentence's own punctuation", () => {
  assert.deepEqual(kinds("Here's the link: https://claude.ai/artifact/WXxaEEVZRJhsWWTu3C6R7W."), [
    ["text", "Here's the link: "],
    ["url", "https://claude.ai/artifact/WXxaEEVZRJhsWWTu3C6R7W"],
    ["text", "."],
  ]);
  assert.deepEqual(kinds("(see https://x.org/a_(b))"), [
    ["text", "(see "],
    ["url", "https://x.org/a_(b)"],
    ["text", ")"],
  ]);
  assert.deepEqual(kinds("[the post](https://www.linkedin.com/feed/) is up"), [
    ["url", "https://www.linkedin.com/feed/"],
    ["text", " is up"],
  ]);
  assert.equal(splitLinks("[the post](https://www.linkedin.com/feed/)")[0].text, "the post");
});

test("file paths are found bare or in code, and code that isn't a link stays code", () => {
  assert.deepEqual(
    kinds("The draft is in `E:/social/outputs/2026-10-05-post.md`. I filed nothing."),
    [
      ["text", "The draft is in "],
      ["path", "E:/social/outputs/2026-10-05-post.md"],
      ["text", ". I filed nothing."],
    ],
  );
  assert.deepEqual(kinds("saved to C:\\Users\\user\\brain\\notes.md, then"), [
    ["text", "saved to "],
    ["path", "C:\\Users\\user\\brain\\notes.md"],
    ["text", ", then"],
  ]);
  assert.deepEqual(kinds("run `npm test` and **ship** it"), [
    ["text", "run "],
    ["code", "npm test"],
    ["text", " and "],
    ["bold", "ship"],
    ["text", " it"],
  ]);
});

test("only web links and full paths become links", () => {
  assert.deepEqual(kinds("[x](javascript:alert(1)) and ratio 3:2 and a/b:c"), [
    ["text", "[x](javascript:alert(1)) and ratio 3:2 and a/b:c"],
  ]);
  assert.deepEqual(kinds("ftp://host/file"), [["text", "ftp://host/file"]]);
  assert.deepEqual(kinds(""), []);
});
