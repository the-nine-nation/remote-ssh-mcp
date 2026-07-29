#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { SessionManager } from "./session-manager.js";

const config = await loadConfig();
const manager = new SessionManager(config);

if (config.allowedHosts.size === 0) {
  console.error(
    "remote-ssh-mcp: no exact SSH Host aliases discovered; add Host aliases to ~/.ssh/config or set SSH_MCP_ALLOWED_HOSTS",
  );
}

const handle = serveStdio(() => buildServer(manager), {
  onerror: (error) => {
    console.error(`remote-ssh-mcp: MCP transport error: ${error.message}`);
  },
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`remote-ssh-mcp: shutting down (${signal})`);
  await manager.closeAll();
  await handle.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(0));
});
process.stdin.once("end", () => {
  void shutdown("stdin EOF").finally(() => process.exit(0));
});
