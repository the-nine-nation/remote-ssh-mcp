import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "../src/session-manager.js";
import type { ServerConfig } from "../src/types.js";

const fakeSsh = resolve("test/fake-ssh.sh");
const fakeHangingSsh = resolve("test/fake-ssh-hang.sh");
await chmod(fakeSsh, 0o755);
await chmod(fakeHangingSsh, 0o755);

async function fixture(
  overrides: Partial<ServerConfig> = {},
): Promise<{ manager: SessionManager; auditLogPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "sshmcp-test-"));
  const auditLogPath = join(directory, "audit.jsonl");
  const manager = new SessionManager({
    allowedHosts: new Set(["test"]),
    allowedHostsSource: ["test"],
    sshPath: fakeSsh,
    maxTimeoutSec: 10,
    defaultWaitSec: 0.1,
    maxWaitSec: 1,
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

test("wait expiry returns running while the command continues", async (t) => {
  const { manager } = await fixture();
  t.after(() => manager.closeAll());
  const opened = await manager.open("test");
  const id = opened.id as string;

  const initial = await manager.run(
    id,
    "sleep 0.15; printf finished",
    undefined,
    0.02,
  );
  assert.equal(initial.status, "running");
  assert.equal(initial.exit_code, null);
  assert.equal(manager.peek(id).status, "running");

  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  const completed = manager.peek(id);
  assert.equal(completed.status, "idle");
  assert.equal(completed.last_exit, 0);
  assert.equal(completed.stdout, "finished");
});

test("peek returns the latest 50 lines by default and accepts a smaller limit", async (t) => {
  const { manager } = await fixture();
  t.after(() => manager.closeAll());
  const opened = await manager.open("test");
  const id = opened.id as string;

  const result = await manager.run(
    id,
    "for i in $(seq 1 80); do printf 'line%s\\n' \"$i\"; done",
    undefined,
    1,
  );
  assert.equal(result.status, "ok");

  const defaultView = manager.peek(id);
  assert.match(defaultView.stdout as string, /^line31\n/);
  assert.match(defaultView.stdout as string, /line80\n$/);
  assert.equal((defaultView.stdout as string).includes("line30\n"), false);

  assert.equal(manager.peek(id, 3).stdout, "line78\nline79\nline80\n");
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

test("closeAll also reclaims an SSH process still opening", async () => {
  const { manager } = await fixture({
    sshPath: fakeHangingSsh,
    openTimeoutSec: 5,
  });
  const opening = manager.open("test");
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));

  const startedAt = Date.now();
  await manager.closeAll();
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal((await opening).status, "connect_failed");
});
