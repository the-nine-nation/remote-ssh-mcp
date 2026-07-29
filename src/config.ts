import { homedir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as z from "zod/v4";
import type { ServerConfig } from "./types.js";

const ConfigFileSchema = z
  .object({
    allowedHosts: z.array(z.string()).optional(),
    sshConfigPath: z.string().optional(),
    sshPath: z.string().optional(),
    defaultTimeoutSec: z.number().positive().optional(),
    maxTimeoutSec: z.number().positive().optional(),
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

  const discoveredHosts = await discoverSshAliases(sshConfigPath, home);
  const configuredHosts = [
    ...(file.allowedHosts ?? []),
    ...splitCsv(env.SSH_MCP_ALLOWED_HOSTS),
  ];
  const allowedHosts = new Set(
    [...discoveredHosts, ...configuredHosts].filter(isSafeHostAlias),
  );

  const maxTimeoutSec = positiveNumber(
    env.SSH_MCP_MAX_TIMEOUT_SEC,
    file.maxTimeoutSec ?? 1_800,
  );
  const defaultTimeoutSec = Math.min(
    positiveNumber(
      env.SSH_MCP_DEFAULT_TIMEOUT_SEC,
      file.defaultTimeoutSec ?? 90,
    ),
    maxTimeoutSec,
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
    allowedHosts,
    allowedHostsSource: [
      `ssh_config:${sshConfigPath}`,
      ...(configuredHosts.length > 0 ? ["explicit configuration"] : []),
    ],
    sshPath: env.SSH_MCP_SSH_PATH ?? file.sshPath ?? "ssh",
    defaultTimeoutSec,
    maxTimeoutSec,
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

export function isSafeHostAlias(host: string): boolean {
  return (
    host.length >= 1 &&
    host.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)
  );
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

async function discoverSshAliases(
  entryPath: string,
  home: string,
): Promise<Set<string>> {
  const aliases = new Set<string>();
  const visited = new Set<string>();
  const includeBase = dirname(resolve(entryPath));

  async function visit(path: string): Promise<void> {
    const normalized = resolve(path);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    let raw: string;
    try {
      raw = await readFile(normalized, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }

    for (const originalLine of raw.split(/\r?\n/)) {
      const line = originalLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.search(/\s/);
      if (separator < 0) continue;
      const keyword = line.slice(0, separator).toLowerCase();
      const value = stripTrailingComment(line.slice(separator).trim());

      if (keyword === "host") {
        for (const candidate of splitSshWords(value)) {
          if (
            !candidate.startsWith("!") &&
            !candidate.includes("*") &&
            !candidate.includes("?") &&
            isSafeHostAlias(candidate)
          ) {
            aliases.add(candidate);
          }
        }
      } else if (keyword === "include") {
        for (const includePattern of splitSshWords(value)) {
          const expanded = expandHome(includePattern, home);
          const absolute = isAbsolute(expanded)
            ? expanded
            : resolve(includeBase, expanded);
          for (const match of await expandSimpleGlob(absolute)) {
            await visit(match);
          }
        }
      }
    }
  }

  await visit(entryPath);
  return aliases;
}

async function expandSimpleGlob(pattern: string): Promise<string[]> {
  if (!pattern.includes("*") && !pattern.includes("?")) return [pattern];
  const directory = dirname(pattern);
  const basename = pattern.slice(directory.length + (directory === "/" ? 0 : 1));
  if (directory.includes("*") || directory.includes("?")) return [];
  const regex = new RegExp(
    `^${basename
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
  );
  try {
    return (await readdir(directory))
      .filter((entry) => regex.test(entry))
      .sort()
      .map((entry) => join(directory, entry));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function splitSshWords(value: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of value.matchAll(pattern)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return words;
}

function stripTrailingComment(value: string): string {
  return value.replace(/\s+#.*$/, "").trim();
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
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
