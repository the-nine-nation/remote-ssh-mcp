import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";
import {
  discoverSshConfig,
  expandHome,
  isSafeHostAlias,
  mergeHostCatalog,
} from "./ssh-config.js";
import type { ServerConfig } from "./types.js";

export { isSafeHostAlias } from "./ssh-config.js";

const ConfigFileSchema = z
  .object({
    allowedHosts: z.array(z.string()).optional(),
    sshConfigPath: z.string().optional(),
    sshPath: z.string().optional(),
    maxTimeoutSec: z.number().positive().optional(),
    defaultWaitSec: z.number().nonnegative().optional(),
    maxWaitSec: z.number().positive().optional(),
    openTimeoutSec: z.number().positive().optional(),
    idleTimeoutSec: z.number().positive().optional(),
    interruptGraceSec: z.number().positive().optional(),
    maxSessions: z.number().int().positive().optional(),
    outputMaxBytes: z.number().int().positive().optional(),
    outputHeadBytes: z.number().int().nonnegative().optional(),
    auditLogPath: z.string().optional(),
  })
  .strict();

type ConfigFile = z.infer<typeof ConfigFileSchema>;

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerConfig> {
  const home = homedir();
  const configPath = expandHome(
    env.SSH_MCP_CONFIG ?? join(home, ".config", "remote-ssh-mcp", "config.json"),
    home,
  );
  const file = await readOptionalJson(configPath);
  const sshConfigPath = expandHome(
    env.SSH_MCP_SSH_CONFIG ?? file.sshConfigPath ?? join(home, ".ssh", "config"),
    home,
  );

  const explicitHosts = [
    ...(file.allowedHosts ?? []),
    ...splitCsv(env.SSH_MCP_ALLOWED_HOSTS),
  ].filter(isSafeHostAlias);

  const hostCatalog = await buildHostCatalog(sshConfigPath, home, explicitHosts);

  const maxTimeoutSec = positiveNumber(
    env.SSH_MCP_MAX_TIMEOUT_SEC,
    file.maxTimeoutSec ?? 1_800,
  );
  const maxWaitSec = positiveNumber(
    env.SSH_MCP_MAX_WAIT_SEC,
    file.maxWaitSec ?? 30,
  );
  const defaultWaitSec = Math.min(
    nonnegativeNumber(
      env.SSH_MCP_DEFAULT_WAIT_SEC,
      file.defaultWaitSec ?? 10,
    ),
    maxWaitSec,
  );
  const outputMaxBytes = positiveInteger(
    env.SSH_MCP_OUTPUT_MAX_BYTES,
    file.outputMaxBytes ?? 32 * 1024,
  );
  const outputHeadBytes = Math.min(
    nonnegativeInteger(
      env.SSH_MCP_OUTPUT_HEAD_BYTES,
      file.outputHeadBytes ?? 4 * 1024,
    ),
    outputMaxBytes,
  );

  return {
    allowedHosts: hostCatalog.allowedHosts,
    hosts: hostCatalog.hosts,
    allowedHostsSource: [
      `ssh_config:${sshConfigPath}`,
      ...(explicitHosts.length > 0 ? ["explicit configuration"] : []),
    ],
    sshConfigPath,
    explicitHosts,
    home,
    sshPath: env.SSH_MCP_SSH_PATH ?? file.sshPath ?? "ssh",
    maxTimeoutSec,
    defaultWaitSec,
    maxWaitSec,
    openTimeoutSec: positiveNumber(
      env.SSH_MCP_OPEN_TIMEOUT_SEC,
      file.openTimeoutSec ?? 20,
    ),
    idleTimeoutSec: positiveNumber(
      env.SSH_MCP_IDLE_TIMEOUT_SEC,
      file.idleTimeoutSec ?? 1_800,
    ),
    interruptGraceSec: positiveNumber(
      env.SSH_MCP_INTERRUPT_GRACE_SEC,
      file.interruptGraceSec ?? 5,
    ),
    maxSessions: positiveInteger(
      env.SSH_MCP_MAX_SESSIONS,
      file.maxSessions ?? 8,
    ),
    outputMaxBytes,
    outputHeadBytes,
    auditLogPath: expandHome(
      env.SSH_MCP_AUDIT_LOG ??
        file.auditLogPath ??
        join(home, ".local", "state", "remote-ssh-mcp", "audit.jsonl"),
      home,
    ),
  };
}

export async function reloadHostCatalog(
  config: ServerConfig,
): Promise<Pick<ServerConfig, "allowedHosts" | "hosts" | "allowedHostsSource">> {
  const hostCatalog = await buildHostCatalog(
    config.sshConfigPath,
    config.home,
    config.explicitHosts,
  );
  return {
    allowedHosts: hostCatalog.allowedHosts,
    hosts: hostCatalog.hosts,
    allowedHostsSource: [
      `ssh_config:${config.sshConfigPath}`,
      ...(config.explicitHosts.length > 0 ? ["explicit configuration"] : []),
    ],
  };
}

async function buildHostCatalog(
  sshConfigPath: string,
  home: string,
  explicitHosts: readonly string[],
): Promise<ReturnType<typeof mergeHostCatalog>> {
  const discovered = await discoverSshConfig(sshConfigPath, home);
  return mergeHostCatalog(discovered, explicitHosts);
}

async function readOptionalJson(path: string): Promise<ConfigFile> {
  try {
    const raw = await readFile(path, "utf8");
    return ConfigFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    if (error instanceof z.ZodError) {
      throw new Error(`invalid SSH MCP config at ${path}: ${z.prettifyError(error)}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`invalid JSON in SSH MCP config at ${path}: ${error.message}`);
    }
    throw error;
  }
}

function splitCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`expected a positive number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = positiveNumber(value, fallback);
  if (!Number.isInteger(parsed)) {
    throw new Error(`expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function nonnegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function nonnegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
