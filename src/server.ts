import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { isSafeHostAlias } from "./config.js";
import { SessionManager } from "./session-manager.js";

const SESSION_ID = /^s_[0-9a-f]{8}$/;

export function buildServer(manager: SessionManager): McpServer {
  const config = manager.config;
  const server = new McpServer(
    {
      name: "remote-ssh-mcp",
      version: "0.2.0",
    },
    {
      instructions: [
        "One session id represents one persistent remote bash shell.",
        "Reuse the same id to preserve cwd and environment variables.",
        "For a clean environment, close the old session and open a new one.",
        "Do not invent ids; use ids returned by ssh_open or ssh_list.",
        "Call ssh_hosts to discover allowed Host aliases from the local OpenSSH config before opening a session.",
        "Never read SSH private keys, IdentityFile paths, or agent sockets from disk. Authentication is handled only by the local OpenSSH client when ssh_open runs.",
        "Avoid interactive TUI programs. Use ssh_peek and ssh_interrupt for a stuck command.",
        "ssh_run may return running after wait_sec while the remote command continues; do not retry it. Poll ssh_peek with wait_sec so the call blocks until the command finishes or the wait expires; do not busy-loop with wait_sec=0. Interrupt it, or open another session for concurrent work.",
        "Commands have no automatic execution timeout unless timeout_sec is explicitly provided; the model owns their lifecycle.",
        "ssh_peek returns the latest 50 lines per stream by default; request a different bounded line count only when needed.",
        "Prefer these tools over wrapping ssh inside a local shell command.",
      ].join(" "),
    },
  );

  server.registerTool(
    "ssh_hosts",
    {
      title: "List allowed SSH Host aliases",
      description:
        "List allowed OpenSSH Host aliases discovered from the local ssh_config (and explicit allowlist). Returns only safe connection metadata: alias, hostname, user, port, proxy_jump. Never returns private keys, IdentityFile paths, agent sockets, or ProxyCommand. Pass reload=true after editing ~/.ssh/config to re-parse without restarting the MCP server. Use an alias from this list with ssh_open.",
      inputSchema: z.object({
        reload: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reload }) => toToolResult(await manager.listHosts(reload)),
  );

  server.registerTool(
    "ssh_open",
    {
      title: "Open persistent SSH session",
      description:
        "Open a new persistent remote bash shell for an allowed ssh_config Host alias from ssh_hosts. Each call creates a clean session with a new id. Credentials come only from local OpenSSH configuration/agent; passwords and private keys are never accepted as arguments and must not be read from disk by the model.",
      inputSchema: z.object({
        host: z
          .string()
          .min(1)
          .max(255)
          .refine(isSafeHostAlias, "must be a safe SSH Host alias"),
        name: z.string().trim().min(1).max(80).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ host, name }) => toToolResult(await manager.open(host, name)),
  );

  server.registerTool(
    "ssh_run",
    {
      title: "Run command in persistent SSH session",
      description:
        "Start a non-interactive command in the same persistent shell identified by id. cwd and environment changes persist. The call waits at most wait_sec (default 10 seconds); if the command is still active it returns status=running without stopping it. Commands have no automatic execution timeout by default. Only an explicitly provided timeout_sec sends Ctrl-C at that deadline. Never retry a running command: poll with ssh_peek(wait_sec=...) so the MCP call blocks until idle or the wait expires; do not spam peeks with wait_sec=0. Call ssh_interrupt to stop it, or open another session for concurrent work. Only one foreground command may run per id. Do not use vim, top, password prompts, or other interactive TUI/input flows.",
      inputSchema: z.object({
        id: z.string().regex(SESSION_ID, "must be an id returned by ssh_open"),
        command: z.string().min(1).max(1024 * 1024),
        timeout_sec: z
          .number()
          .positive()
          .max(config.maxTimeoutSec)
          .optional(),
        wait_sec: z
          .number()
          .nonnegative()
          .max(config.maxWaitSec)
          .default(config.defaultWaitSec),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, command, timeout_sec, wait_sec }) =>
      toToolResult(await manager.run(id, command, timeout_sec, wait_sec)),
  );

  server.registerTool(
    "ssh_peek",
    {
      title: "Peek at SSH command output",
      description:
        "Observe the current foreground command and its latest output without starting another command. When status=running, optional wait_sec (default 0) long-polls this MCP call until the command finishes or the wait expires—prefer a positive wait_sec over busy-looping. wait_sec never stops the remote command. Returns the newest lines in chronological order, limited independently for stdout and stderr; lines defaults to 50 and is capped to protect model context. Use after ssh_run returns status=running. When idle, returns immediately with cwd, last exit code, and the latest lines from the completed command.",
      inputSchema: z.object({
        id: z.string().regex(SESSION_ID, "must be an id returned by ssh_open"),
        lines: z.number().int().positive().max(1_000).default(50),
        wait_sec: z
          .number()
          .nonnegative()
          .max(config.maxWaitSec)
          .default(0),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, lines, wait_sec }) =>
      toToolResult(await manager.peek(id, lines, wait_sec)),
  );

  server.registerTool(
    "ssh_interrupt",
    {
      title: "Interrupt SSH foreground command",
      description:
        "Send Ctrl-C to the current foreground process group and wait for the shell protocol to recover. The session is kept only when recovery is confirmed. Returns nothing_to_interrupt when idle.",
      inputSchema: z.object({
        id: z.string().regex(SESSION_ID, "must be an id returned by ssh_open"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id }) => toToolResult(await manager.interrupt(id)),
  );

  server.registerTool(
    "ssh_list",
    {
      title: "List persistent SSH sessions",
      description:
        "List all live sessions with host, cwd, state, last exit code, idle time, idle-reap countdown, and connection capacity. Use this to recover valid ids; never invent one.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => toToolResult(manager.list()),
  );

  server.registerTool(
    "ssh_close",
    {
      title: "Close persistent SSH session",
      description:
        "Close the remote shell and SSH connection, clean its private temporary directory, and invalidate the id. Close a dirty session and call ssh_open for a clean environment.",
      inputSchema: z.object({
        id: z.string().regex(SESSION_ID, "must be an id returned by ssh_open"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => toToolResult(await manager.close(id)),
  );

  return server;
}

function toToolResult(value: Record<string, unknown>): CallToolResult {
  const status = typeof value.status === "string" ? value.status : "unknown";
  const errorStatuses = new Set([
    "host_not_allowed",
    "connect_failed",
    "connection_limit",
    "server_closing",
    "session_gone",
    "shell_dead",
    "command_denied",
    "busy",
    "nothing_to_interrupt",
  ]);
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: errorStatuses.has(status),
  };
}
