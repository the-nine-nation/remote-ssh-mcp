import assert from "node:assert/strict";
import test from "node:test";
import { HeadTailBuffer } from "../src/output-buffer.js";
import {
  buildRunFrame,
  parseReadyMarker,
  RunFrameParser,
  shellSingleQuote,
} from "../src/protocol.js";

test("shellSingleQuote preserves quotes, newlines, comments, and substitutions", () => {
  const command = "printf '%s\\n' \"$HOME\" # trailing\nprintf done";
  const quoted = shellSingleQuote(command);
  assert.equal(quoted.startsWith("'"), true);
  assert.equal(quoted.endsWith("'"), true);
  assert.match(quoted, /'\"'\"'/);
});

test("buildRunFrame does not splice raw command syntax into the wrapper", () => {
  const frame = buildRunFrame(
    "0123456789abcdef0123456789abcdef",
    "printf ok # swallow the rest",
    "/tmp/private/stderr",
  );
  assert.match(frame, /builtin eval -- 'printf ok # swallow the rest'/);
  assert.match(frame, /__sshmcp_rc_0123456789abcdef0123456789abcdef=\$\?/);
});

test("RunFrameParser handles split markers and separates stderr", () => {
  const token = "0123456789abcdef0123456789abcdef";
  const stdout = new HeadTailBuffer(1024, 128);
  const stderr = new HeadTailBuffer(1024, 128);
  const parser = new RunFrameParser(token, stdout, stderr);
  const cwd = Buffer.from("/tmp/目录").toString("base64");
  const wire = Buffer.from(
    `hello\n__SSHMCP_EXIT:7:${token}:${cwd}__\n` +
      `__SSHMCP_ERR_BEGIN:${token}__\nproblem` +
      `\n__SSHMCP_ERR_END:${token}__\n`,
  );

  let parsed;
  for (let offset = 0; offset < wire.length; offset += 3) {
    parsed = parser.push(wire.subarray(offset, offset + 3)) ?? parsed;
  }
  assert.deepEqual(parsed, { exitCode: 7, cwd: "/tmp/目录" });
  assert.equal(stdout.toString(), "hello");
  assert.equal(stderr.toString(), "problem");
});

test("parseReadyMarker ignores banner bytes", () => {
  const token = "fedcba9876543210fedcba9876543210";
  const cwd = Buffer.from("/home/app").toString("base64");
  const parsed = parseReadyMarker(
    Buffer.from(`banner\r\n__SSHMCP_READY:0:${token}:${cwd}__\n`),
    token,
  );
  assert.equal(parsed?.exitCode, 0);
  assert.equal(parsed?.cwd, "/home/app");
});
