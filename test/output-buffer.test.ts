import assert from "node:assert/strict";
import test from "node:test";
import {
  HeadTailBuffer,
  latestLines,
  presentOutput,
  sanitizeForModel,
  stripAnsi,
} from "../src/output-buffer.js";

test("HeadTailBuffer retains complete output below the limit", () => {
  const output = new HeadTailBuffer(16, 4);
  output.append("hello ");
  output.append("world");
  assert.equal(output.toString(), "hello world");
  assert.equal(output.truncated, false);
  assert.equal(output.totalBytes, 11);
});

test("HeadTailBuffer retains head and tail and reports omitted bytes", () => {
  const output = new HeadTailBuffer(8, 3);
  output.append("abcdefghijklmnop");
  assert.equal(output.truncated, true);
  assert.match(output.toString(), /^abc\n… \[8 bytes truncated\] …\nlmnop$/);
});

test("HeadTailBuffer never emits malformed UTF-8 at a truncation edge", () => {
  const output = new HeadTailBuffer(5, 2);
  output.append("甲乙丙丁");
  assert.equal(output.truncated, true);
  assert.equal(output.toString().includes("�"), false);
});

test("latestLines returns newest lines and handles terminal carriage returns", () => {
  assert.equal(latestLines("one\ntwo\nthree\n", 2), "two\nthree\n");
  assert.equal(latestLines("step 1\rstep 2\rstep 3", 2), "step 2\nstep 3");
});

test("stripAnsi removes bracketed paste, colors, and OSC sequences", () => {
  const noisy =
    "\u001b[?2004l\n\u001b[?2004h" +
    "\u001b[32m✓ hf version\u001b[0m\n" +
    "\u001b]0;title\u0007plain\n";
  assert.equal(stripAnsi(noisy), "\n✓ hf version\nplain\n");
});

test("sanitizeForModel collapses control-only lines and applies CR overwrite", () => {
  const noisy =
    "\u001b[?2004l\n" +
    "\u001b[?2004h\u001b[?2004l\n" +
    "hello\n" +
    "\u001b[?2004h\n" +
    "progress 1\rprogress 2\rprogress done\n" +
    "\u001b[32mOK\u001b[0m\n" +
    "\u001b[?2004l\n";
  assert.equal(sanitizeForModel(noisy), "hello\nprogress done\nOK\n");
});

test("presentOutput sanitizes then keeps only the newest N lines", () => {
  const raw =
    "\u001b[?2004h\nline1\n\u001b[?2004l\nline2\nline3\nline4\n";
  assert.equal(presentOutput(raw, 2), "line3\nline4\n");
  assert.equal(presentOutput(raw), "line1\nline2\nline3\nline4\n");
});

test("presentOutput empties streams that were only terminal noise", () => {
  assert.equal(
    presentOutput("\u001b[?2004h\u001b[?2004l\n\u001b[?2004h\n"),
    "",
  );
});
