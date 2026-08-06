import assert from "node:assert/strict";
import test from "node:test";
import { slimToolPayload } from "../src/server.js";

test("slimToolPayload drops empty stderr, false flags, and lines echo", () => {
  const slim = slimToolPayload({
    id: "s_deadbeef",
    status: "ok",
    exit_code: 0,
    stdout: "hello\n",
    stderr: "",
    truncated: false,
    stdout_truncated: false,
    stderr_truncated: false,
    interrupted: false,
    session_gone: false,
    lines: 40,
    cwd: "/tmp",
    duration_ms: 12,
  });
  assert.deepEqual(slim, {
    id: "s_deadbeef",
    status: "ok",
    exit_code: 0,
    stdout: "hello\n",
    cwd: "/tmp",
    duration_ms: 12,
  });
});

test("slimToolPayload keeps true truncation flags and non-empty stderr", () => {
  const slim = slimToolPayload({
    id: "s_cafebabe",
    status: "ok",
    exit_code: 0,
    stdout: "head",
    stderr: "warn",
    truncated: true,
    stdout_truncated: true,
    stderr_truncated: false,
    cwd: "/home",
    duration_ms: 1,
  });
  assert.deepEqual(slim, {
    id: "s_cafebabe",
    status: "ok",
    exit_code: 0,
    stdout: "head",
    stderr: "warn",
    truncated: true,
    stdout_truncated: true,
    cwd: "/home",
    duration_ms: 1,
  });
});

test("slimToolPayload keeps empty stdout so silence is explicit", () => {
  const slim = slimToolPayload({
    status: "ok",
    stdout: "",
    stderr: "",
    truncated: false,
  });
  assert.deepEqual(slim, { status: "ok", stdout: "" });
});
