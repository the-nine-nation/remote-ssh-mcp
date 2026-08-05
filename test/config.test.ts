import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, reloadHostCatalog } from "../src/config.js";

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
  assert.equal(config.defaultWaitSec, 10);
  assert.equal(config.maxWaitSec, 30);
  assert.equal(config.sshConfigPath, sshConfig);
});

test("config exposes safe Host metadata and never surfaces credential paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sshmcp-hosts-"));
  const sshConfig = join(directory, "ssh-config");
  const appConfig = join(directory, "config.json");
  await writeFile(
    sshConfig,
    [
      "Host jumpbox",
      "  HostName jump.example.com",
      "  User deploy",
      "  Port 2222",
      "  ProxyJump bastion",
      "  IdentityFile ~/.ssh/id_ed25519_prod",
      "  CertificateFile ~/.ssh/id_ed25519_prod-cert.pub",
      "  IdentityAgent ~/Library/Group Containers/agent.sock",
      "  ProxyCommand ssh -W %h:%p bastion",
      "",
      "Host jumpbox",
      "  HostName should-not-override.example.com",
      "  User later-user",
      "",
      "Host bare",
      "  # comment only",
      "",
    ].join("\n"),
  );
  await writeFile(
    appConfig,
    JSON.stringify({
      allowedHosts: ["manual-only"],
      sshConfigPath: sshConfig,
      auditLogPath: join(directory, "audit.jsonl"),
    }),
  );

  const config = await loadConfig({ SSH_MCP_CONFIG: appConfig });
  const jumpbox = config.hosts.find((host) => host.alias === "jumpbox");
  assert.ok(jumpbox);
  assert.equal(jumpbox.hostname, "jump.example.com");
  assert.equal(jumpbox.user, "deploy");
  assert.equal(jumpbox.port, 2222);
  assert.equal(jumpbox.proxy_jump, "bastion");
  assert.deepEqual(jumpbox.sources, ["ssh_config"]);

  const serialized = JSON.stringify(config.hosts);
  assert.equal(serialized.includes("IdentityFile"), false);
  assert.equal(serialized.includes("id_ed25519"), false);
  assert.equal(serialized.includes("CertificateFile"), false);
  assert.equal(serialized.includes("IdentityAgent"), false);
  assert.equal(serialized.includes("ProxyCommand"), false);
  assert.equal(serialized.includes("agent.sock"), false);

  const manual = config.hosts.find((host) => host.alias === "manual-only");
  assert.ok(manual);
  assert.deepEqual(manual.sources, ["explicit"]);
  assert.equal(manual.hostname, undefined);
});

test("reloadHostCatalog picks up new Host aliases without restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sshmcp-reload-"));
  const sshConfig = join(directory, "ssh-config");
  const appConfig = join(directory, "config.json");
  await writeFile(sshConfig, "Host alpha\n  HostName a.example.com\n");
  await writeFile(
    appConfig,
    JSON.stringify({
      sshConfigPath: sshConfig,
      auditLogPath: join(directory, "audit.jsonl"),
    }),
  );

  const config = await loadConfig({ SSH_MCP_CONFIG: appConfig });
  assert.deepEqual(
    config.hosts.map((host) => host.alias),
    ["alpha"],
  );

  await writeFile(
    sshConfig,
    [
      "Host alpha",
      "  HostName a.example.com",
      "Host beta",
      "  HostName b.example.com",
      "  User ops",
      "",
    ].join("\n"),
  );

  const reloaded = await reloadHostCatalog(config);
  assert.deepEqual(
    reloaded.hosts.map((host) => host.alias),
    ["alpha", "beta"],
  );
  const beta = reloaded.hosts.find((host) => host.alias === "beta");
  assert.ok(beta);
  assert.equal(beta.hostname, "b.example.com");
  assert.equal(beta.user, "ops");
  assert.equal(reloaded.allowedHosts.has("beta"), true);
});
