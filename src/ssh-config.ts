import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HostCatalogEntry, HostSource } from "./types.js";

/** Keywords that may appear in ssh_hosts output. Everything else is ignored. */
const SAFE_OPTION_KEYWORDS = new Set([
  "hostname",
  "user",
  "port",
  "proxyjump",
]);

/**
 * Credential-related keywords are intentionally never returned to the model.
 * OpenSSH still applies them when spawning `ssh`; tools must not surface paths
 * that would tempt agents to Read private keys from disk.
 */
const CREDENTIAL_KEYWORDS = new Set([
  "identityfile",
  "certificatefile",
  "identityagent",
  "pkcs11provider",
  "securitykeyprovider",
  "proxycommand",
  "localcommand",
  "remotecommand",
  "passwordauthentication",
  "kbdinteractiveauthentication",
  "challengeresponseauthentication",
  "gssapiauthentication",
  "preferredauthentications",
]);

export interface DiscoveredSshConfig {
  readonly aliases: ReadonlySet<string>;
  readonly entries: readonly HostCatalogEntry[];
}

export async function discoverSshConfig(
  entryPath: string,
  home: string,
): Promise<DiscoveredSshConfig> {
  const visited = new Set<string>();
  const includeBase = dirname(resolve(entryPath));
  /** First-wins option map per exact alias (OpenSSH semantics). */
  const optionsByAlias = new Map<string, Map<string, string>>();
  const aliases = new Set<string>();

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

    let currentExactAliases: string[] = [];

    for (const originalLine of raw.split(/\r?\n/)) {
      const line = originalLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.search(/\s/);
      if (separator < 0) continue;
      const keyword = line.slice(0, separator).toLowerCase();
      const value = stripTrailingComment(line.slice(separator).trim());

      if (keyword === "host") {
        currentExactAliases = [];
        for (const candidate of splitSshWords(value)) {
          if (
            !candidate.startsWith("!") &&
            !candidate.includes("*") &&
            !candidate.includes("?") &&
            isSafeHostAlias(candidate)
          ) {
            aliases.add(candidate);
            currentExactAliases.push(candidate);
            if (!optionsByAlias.has(candidate)) {
              optionsByAlias.set(candidate, new Map());
            }
          }
        }
        continue;
      }

      if (keyword === "match") {
        // Match blocks are not expanded; stop attributing Host options.
        currentExactAliases = [];
        continue;
      }

      if (keyword === "include") {
        for (const includePattern of splitSshWords(value)) {
          const expanded = expandHome(includePattern, home);
          const absolute = isAbsolute(expanded)
            ? expanded
            : resolve(includeBase, expanded);
          for (const match of await expandSimpleGlob(absolute)) {
            await visit(match);
          }
        }
        continue;
      }

      if (currentExactAliases.length === 0) continue;
      if (CREDENTIAL_KEYWORDS.has(keyword)) continue;
      if (!SAFE_OPTION_KEYWORDS.has(keyword)) continue;
      if (!value) continue;

      for (const alias of currentExactAliases) {
        const options = optionsByAlias.get(alias);
        if (!options || options.has(keyword)) continue;
        options.set(keyword, value);
      }
    }
  }

  await visit(entryPath);

  const entries: HostCatalogEntry[] = [...aliases]
    .sort((left, right) => left.localeCompare(right))
    .map((alias) =>
      toCatalogEntry(alias, optionsByAlias.get(alias) ?? new Map(), [
        "ssh_config",
      ]),
    );

  return { aliases, entries };
}

export function mergeHostCatalog(
  discovered: DiscoveredSshConfig,
  explicitHosts: readonly string[],
): {
  readonly allowedHosts: ReadonlySet<string>;
  readonly hosts: readonly HostCatalogEntry[];
} {
  const byAlias = new Map<string, HostCatalogEntry>();
  for (const entry of discovered.entries) {
    byAlias.set(entry.alias, entry);
  }

  for (const host of explicitHosts) {
    if (!isSafeHostAlias(host)) continue;
    const existing = byAlias.get(host);
    if (existing) {
      if (!existing.sources.includes("explicit")) {
        byAlias.set(host, {
          ...existing,
          sources: [...existing.sources, "explicit"],
        });
      }
      continue;
    }
    byAlias.set(host, {
      alias: host,
      sources: ["explicit"],
    });
  }

  const hosts = [...byAlias.values()].sort((left, right) =>
    left.alias.localeCompare(right.alias),
  );
  return {
    allowedHosts: new Set(hosts.map((entry) => entry.alias)),
    hosts,
  };
}

export function isSafeHostAlias(host: string): boolean {
  return (
    host.length >= 1 &&
    host.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)
  );
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function toCatalogEntry(
  alias: string,
  options: ReadonlyMap<string, string>,
  sources: readonly HostSource[],
): HostCatalogEntry {
  const entry: {
    alias: string;
    hostname?: string;
    user?: string;
    port?: number;
    proxy_jump?: string;
    sources: readonly HostSource[];
  } = {
    alias,
    sources,
  };

  const hostname = options.get("hostname");
  if (hostname !== undefined) entry.hostname = hostname;

  const user = options.get("user");
  if (user !== undefined) entry.user = user;

  const portRaw = options.get("port");
  if (portRaw !== undefined) {
    const port = Number(portRaw);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
      entry.port = port;
    }
  }

  const proxyJump = options.get("proxyjump");
  if (proxyJump !== undefined) entry.proxy_jump = proxyJump;

  return entry;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
