import assert from "node:assert/strict";
import test from "node:test";
import { HeadTailBuffer } from "../src/output-buffer.js";

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
