import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("config discovers exact ssh aliases through Include and ignores patterns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sshmcp-config-"));
  const includeDirectory = join(directory, "config.d");
  const sshConfig = join(directory, "ssh-config");
  const appConfig = join(directory, "config.json");
  await mkdir(includeDirectory);
  await writeFile(
    sshConfig,
    [
      "Host prod *.example !blocked",
      "  HostName prod.example.com",
      "Include config.d/*",
      "",
    ].join("\n"),
  );
  await writeFile(join(includeDirectory, "staging"), "Host staging\n");
  await writeFile(
    appConfig,
    JSON.stringify({
      allowedHosts: ["manual"],
      sshConfigPath: sshConfig,
      auditLogPath: join(directory, "audit.jsonl"),
    }),
  );

  const config = await loadConfig({
    SSH_MCP_CONFIG: appConfig,
    SSH_MCP_ALLOWED_HOSTS: "envhost",
  });
  assert.deepEqual([...config.allowedHosts].sort(), [
    "envhost",
    "manual",
    "prod",
    "staging",
  ]);
  assert.equal(config.allowedHosts.has("*.example"), false);
  assert.equal(config.allowedHosts.has("blocked"), false);
});
