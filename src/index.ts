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

let shutdownPromise: Promise<void> | undefined;
const originalParentPid = process.ppid;
const parentWatch = setInterval(() => {
  if (originalParentPid !== 1 && process.ppid === 1) {
    beginShutdown("parent process exited");
  }
}, 1_000);
parentWatch.unref();

async function shutdown(reason: string): Promise<void> {
  clearInterval(parentWatch);
  console.error(`remote-ssh-mcp: shutting down (${reason})`);
  await manager.closeAll();
  try {
    await handle.close();
  } catch (error) {
    console.error(
      `remote-ssh-mcp: transport close failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function beginShutdown(reason: string, exitCode = 0): void {
  if (shutdownPromise) return;
  shutdownPromise = shutdown(reason);
  void shutdownPromise.then(
    () => process.exit(exitCode),
    (error) => {
      console.error(
        `remote-ssh-mcp: shutdown failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    },
  );
}

process.once("SIGINT", () => {
  beginShutdown("SIGINT");
});
process.once("SIGTERM", () => {
  beginShutdown("SIGTERM");
});
process.once("SIGHUP", () => {
  beginShutdown("SIGHUP");
});
process.stdin.once("end", () => {
  beginShutdown("stdin EOF");
});
process.stdin.once("close", () => {
  beginShutdown("stdin closed");
});
process.stdin.once("error", (error) => {
  beginShutdown(`stdin error: ${error.message}`, 1);
});
process.stdout.once("error", (error: NodeJS.ErrnoException) => {
  beginShutdown(
    error.code === "EPIPE" ? "MCP output pipe closed" : `stdout error: ${error.message}`,
    error.code === "EPIPE" ? 0 : 1,
  );
});
process.once("disconnect", () => {
  beginShutdown("parent IPC disconnected");
});
process.once("uncaughtException", (error) => {
  console.error(`remote-ssh-mcp: uncaught exception: ${error.stack ?? error.message}`);
  beginShutdown("uncaught exception", 1);
});
process.once("unhandledRejection", (reason) => {
  console.error(
    `remote-ssh-mcp: unhandled rejection: ${
      reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    }`,
  );
  beginShutdown("unhandled rejection", 1);
});
