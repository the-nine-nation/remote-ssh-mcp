import assert from "node:assert/strict";
import test from "node:test";
import { HeadTailBuffer } from "../src/output-buffer.js";
import {
  buildOpenFrame,
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

test("parseReadyMarker skips PTY-echoed open-frame template", () => {
  const token = "192f749c458e5355";
  const cwd = Buffer.from("/root").toString("base64");
  // ssh -tt echoes the open frame before stty -echo; the printf template
  // contains a literal __SSHMCP_READY: prefix that must not trap the parser.
  const openFrame = buildOpenFrame(token, "/tmp/.sshmcp-test");
  const echoed = openFrame.replaceAll("\n", "\r\n");
  const wire = Buffer.from(
    `${echoed}command stty -echo -onlcr\r\n\n__SSHMCP_READY:0:${token}:${cwd}__\n`,
  );
  const parsed = parseReadyMarker(wire, token);
  assert.equal(parsed?.exitCode, 0);
  assert.equal(parsed?.cwd, "/root");
  assert.ok(parsed && parsed.consumed > 0);
  assert.equal(
    wire.subarray(parsed.consumed).includes(Buffer.from("__SSHMCP_READY:")),
    false,
  );
});

test("parseReadyMarker waits when only an incomplete false marker is present", () => {
  const token = "abcdef0123456789";
  const partial = Buffer.from(
    `builtin printf '\\n__SSHMCP_READY:%s:${token}:%s__\\n'`,
  );
  assert.equal(parseReadyMarker(partial, token), undefined);
});
