import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "../src/session-manager.js";
import type { ServerConfig } from "../src/types.js";

const fakeSsh = resolve("test/fake-ssh.sh");
await chmod(fakeSsh, 0o755);

async function fixture(
  overrides: Partial<ServerConfig> = {},
): Promise<{ manager: SessionManager; auditLogPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "sshmcp-test-"));
  const auditLogPath = join(directory, "audit.jsonl");
  const manager = new SessionManager({
    allowedHosts: new Set(["test"]),
    allowedHostsSource: ["test"],
    sshPath: fakeSsh,
    defaultTimeoutSec: 1,
    maxTimeoutSec: 10,
    openTimeoutSec: 2,
    idleTimeoutSec: 60,
    interruptGraceSec: 0.05,
    maxSessions: 2,
    outputMaxBytes: 1024,
    outputHeadBytes: 128,
    auditLogPath,
    ...overrides,
  });
  return { manager, auditLogPath };
}

test("persistent session preserves cwd/env and separates output", async (t) => {
  const { manager, auditLogPath } = await fixture();
  t.after(() => manager.closeAll());
  const opened = await manager.open("test", "fixture");
  assert.equal(opened.status, "idle");
  const id = opened.id as string;

  const first = await manager.run(
    id,
    "export SSHMCP_TEST=value; cd /tmp; printf 'out'; printf 'err' >&2 # trailing",
    1,
  );
  assert.equal(first.status, "ok");
  assert.equal(first.stdout, "out");
  assert.equal(first.stderr, "err");
  assert.equal(first.cwd, "/tmp");

  const second = await manager.run(
    id,
    "printf '%s:%s' \"$SSHMCP_TEST\" \"$PWD\"",
    1,
  );
  assert.equal(second.stdout, "value:/tmp");

  const closed = await manager.close(id);
  assert.equal(closed.status, "closed");
  assert.equal((await manager.peek(id)).status, "session_gone");

  const audit = await readFile(auditLogPath, "utf8");
  assert.match(audit, /"event":"open"/);
  assert.match(audit, /"command_sha256":/);
  assert.match(audit, /"command_name":"export"/);
  assert.match(audit, /"event":"close"/);
});

test("same-session concurrency returns busy without queueing", async (t) => {
  const { manager } = await fixture();
  t.after(() => manager.closeAll());
  const opened = await manager.open("test");
  const id = opened.id as string;
  const running = manager.run(id, "sleep 2", 5);
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));

  assert.equal((await manager.run(id, "printf nope", 1)).status, "busy");
  assert.equal(manager.peek(id).status, "running");
  await manager.close(id);
  assert.equal((await running).status, "shell_dead");
});

test("unrecoverable timeout closes the session instead of claiming idle", async (t) => {
  const { manager } = await fixture();
  t.after(() => manager.closeAll());
  const opened = await manager.open("test");
  const id = opened.id as string;
  const result = await manager.run(id, "sleep 2", 0.05);

  assert.equal(result.status, "timeout");
  assert.equal(result.session_gone, true);
  assert.equal(manager.peek(id).status, "session_gone");
});

test("a command that kills the shell returns shell_dead and invalidates the id", async (t) => {
  const { manager } = await fixture();
  t.after(() => manager.closeAll());
  const opened = await manager.open("test");
  const id = opened.id as string;
  const result = await manager.run(id, "kill $$", 1);

  assert.equal(result.status, "shell_dead");
  assert.equal(result.session_gone, true);
  assert.equal(manager.peek(id).status, "session_gone");
});

test("host allowlist and command denylist fail closed", async (t) => {
  const { manager } = await fixture();
  t.after(() => manager.closeAll());
  assert.equal((await manager.open("unknown")).status, "host_not_allowed");
  const opened = await manager.open("test");
  const result = await manager.run(opened.id as string, "sudo rm -rf /", 1);
  assert.equal(result.status, "command_denied");
});
