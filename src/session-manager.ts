import { randomBytes } from "node:crypto";
import { AuditLogger, commandAuditFields } from "./audit.js";
import { checkDenylist } from "./denylist.js";
import { SshSession } from "./session.js";
import type { ServerConfig } from "./types.js";

export class SessionManager {
  readonly #config: ServerConfig;
  readonly #audit: AuditLogger;
  readonly #sessions = new Map<string, SshSession>();
  readonly #openingSessions = new Set<SshSession>();
  readonly #reaper: NodeJS.Timeout;
  #openingCount = 0;
  #closed = false;

  constructor(config: ServerConfig) {
    this.#config = config;
    this.#audit = new AuditLogger(config.auditLogPath);
    const intervalMs = Math.max(
      1_000,
      Math.min(30_000, (config.idleTimeoutSec * 1_000) / 2),
    );
    this.#reaper = setInterval(() => {
      void this.#reapIdle();
    }, intervalMs);
    this.#reaper.unref();
  }

  get config(): ServerConfig {
    return this.#config;
  }

  async open(
    host: string,
    name?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) {
      return {
        status: "server_closing",
        message: "the MCP server is shutting down",
      };
    }
    if (!this.#config.allowedHosts.has(host)) {
      return {
        status: "host_not_allowed",
        host,
        message:
          "host must be an exact, non-wildcard Host alias from ssh_config or SSH_MCP_ALLOWED_HOSTS",
        allowed_hosts: [...this.#config.allowedHosts].sort(),
      };
    }
    if (
      this.#sessions.size + this.#openingCount >=
      this.#config.maxSessions
    ) {
      return {
        status: "connection_limit",
        host,
        connection_count: this.#sessions.size,
        opening_count: this.#openingCount,
        max_sessions: this.#config.maxSessions,
        message: "close an existing session before opening another",
      };
    }

    this.#openingCount += 1;
    const id = this.#newId();
    const startedAt = Date.now();
    let openingSession: SshSession | undefined;
    try {
      const opened = await SshSession.open(
        id,
        host,
        name,
        this.#config,
        (session, reason) => {
          if (this.#sessions.get(session.id) === session) {
            this.#sessions.delete(session.id);
          }
          if (reason !== "closed" && reason !== "shutdown") {
            void this.#audit.write({
              event: reason === "idle_timeout" ? "idle_reap" : "shell_dead",
              id: session.id,
              host: session.host,
              ...(session.name === undefined ? {} : { name: session.name }),
              status: reason,
            });
          }
        },
        (session) => {
          openingSession = session;
          this.#openingSessions.add(session);
        },
      );
      this.#openingSessions.delete(opened.session);
      if (opened.session.state === "closed") {
        throw new Error("SSH shell exited during the open handshake");
      }
      if (this.#closed) {
        await opened.session.close("shutdown");
        return {
          status: "server_closing",
          host,
          message: "the MCP server started shutting down during ssh_open",
        };
      }
      this.#sessions.set(id, opened.session);
      await this.#audit.write({
        event: "open",
        id,
        host,
        ...(name === undefined ? {} : { name }),
        status: "ok",
        duration_ms: Date.now() - startedAt,
      });
      return {
        id,
        host,
        ...(name === undefined ? {} : { name }),
        cwd: opened.cwd,
        status: "idle",
      };
    } catch (error) {
      const message = errorMessage(error);
      await this.#audit.write({
        event: "open",
        id,
        host,
        ...(name === undefined ? {} : { name }),
        status: "connect_failed",
        duration_ms: Date.now() - startedAt,
        message,
      });
      return {
        status: "connect_failed",
        host,
        message,
      };
    } finally {
      if (openingSession) this.#openingSessions.delete(openingSession);
      this.#openingCount -= 1;
    }
  }

  async run(
    id: string,
    command: string,
    timeoutSec?: number,
    waitSec = this.#config.defaultWaitSec,
  ): Promise<Record<string, unknown>> {
    const session = this.#sessions.get(id);
    if (!session) return gone(id);
    const decision = checkDenylist(command);
    if (decision.denied) {
      const result = {
        id,
        status: "command_denied",
        message: `command blocked by built-in safety rule: ${decision.rule}`,
      };
      await this.#audit.write({
        event: "run",
        id,
        host: session.host,
        ...(session.name === undefined ? {} : { name: session.name }),
        status: "command_denied",
        ...commandAuditFields(command),
        ...(decision.rule === undefined ? {} : { message: decision.rule }),
      });
      return result;
    }

    const result = await session.run(command, timeoutSec, waitSec);
    await this.#audit.write({
      event: "run",
      id,
      host: session.host,
      ...(session.name === undefined ? {} : { name: session.name }),
      status: result.status,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      ...commandAuditFields(command),
      ...(result.message === undefined ? {} : { message: result.message }),
    });
    return { ...result };
  }

  async peek(
    id: string,
    lines = 50,
    waitSec = 0,
  ): Promise<Record<string, unknown>> {
    const session = this.#sessions.get(id);
    if (!session) return gone(id);
    return session.peek(lines, waitSec);
  }

  async interrupt(id: string): Promise<Record<string, unknown>> {
    const session = this.#sessions.get(id);
    if (!session) return gone(id);
    const result = await session.interrupt();
    await this.#audit.write({
      event: "interrupt",
      id,
      host: session.host,
      ...(session.name === undefined ? {} : { name: session.name }),
      status: result.status,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      ...(result.message === undefined ? {} : { message: result.message }),
    });
    return { ...result };
  }

  list(): Record<string, unknown> {
    const now = Date.now();
    return {
      status: "ok",
      connection_count: this.#sessions.size,
      opening_count: this.#openingCount,
      max_sessions: this.#config.maxSessions,
      sessions: [...this.#sessions.values()]
        .map((session) => session.summary(now))
        .sort((left, right) => left.created_at.localeCompare(right.created_at)),
    };
  }

  async close(id: string): Promise<Record<string, unknown>> {
    const session = this.#sessions.get(id);
    if (!session) return gone(id);
    this.#sessions.delete(id);
    await session.close("closed");
    await this.#audit.write({
      event: "close",
      id,
      host: session.host,
      ...(session.name === undefined ? {} : { name: session.name }),
      status: "closed",
    });
    return {
      id,
      status: "closed",
      message: "session closed and resources released",
    };
  }

  async closeAll(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#reaper);
    const sessions = new Set([
      ...this.#sessions.values(),
      ...this.#openingSessions,
    ]);
    this.#sessions.clear();
    this.#openingSessions.clear();
    await Promise.allSettled(
      [...sessions].map((session) => session.close("shutdown")),
    );
  }

  async #reapIdle(): Promise<void> {
    const deadline = Date.now() - this.#config.idleTimeoutSec * 1_000;
    const expired = [...this.#sessions.values()].filter(
      (session) =>
        session.state === "idle" && session.lastActivity <= deadline,
    );
    for (const session of expired) {
      if (this.#sessions.get(session.id) !== session) continue;
      this.#sessions.delete(session.id);
      await session.close("idle_timeout");
    }
  }

  #newId(): string {
    let id: string;
    do {
      id = `s_${randomBytes(4).toString("hex")}`;
    } while (this.#sessions.has(id));
    return id;
  }
}

function gone(id: string): Record<string, unknown> {
  return {
    id,
    status: "session_gone",
    session_gone: true,
    message: "unknown or closed session; call ssh_open again",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
