import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { HeadTailBuffer, presentOutput } from "./output-buffer.js";
import {
  buildOpenFrame,
  buildRunFrame,
  parseReadyMarker,
  RunFrameParser,
  shellSingleQuote,
} from "./protocol.js";
import type {
  CommandResult,
  OutputSnapshot,
  ServerConfig,
  SessionState,
  SessionSummary,
} from "./types.js";

interface ActiveCommand {
  token: string;
  parser: RunFrameParser;
  stdout: HeadTailBuffer;
  stderr: HeadTailBuffer;
  startedAt: number;
  promise: Promise<CommandResult>;
  resolve: (result: CommandResult) => void;
  timeoutTimer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
  interruptReason?: "timeout" | "interrupted";
  settled: boolean;
}

export interface OpenedSession {
  session: SshSession;
  cwd?: string;
}

export type SessionClosedCallback = (
  session: SshSession,
  reason: string,
) => void;

export type SessionCreatedCallback = (session: SshSession) => void;

export class SshSession {
  readonly id: string;
  readonly host: string;
  readonly name?: string;
  readonly createdAt = Date.now();
  readonly #config: ServerConfig;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #privateDir: string;
  readonly #onClosed: SessionClosedCallback;

  #state: SessionState = "idle";
  #cwd: string | undefined;
  #lastExit: number | null = null;
  #lastResult?: CommandResult;
  #lastActivity = Date.now();
  #active: ActiveCommand | undefined;
  #opening = true;
  #openBuffer = Buffer.alloc(0);
  #openError = new HeadTailBuffer(16 * 1024, 2 * 1024);
  #openResolve: ((cwd?: string) => void) | undefined;
  #openReject: ((error: Error) => void) | undefined;
  #closeReason = "closed";
  #closedNotified = false;

  private constructor(
    id: string,
    host: string,
    name: string | undefined,
    config: ServerConfig,
    child: ChildProcessWithoutNullStreams,
    privateDir: string,
    onClosed: SessionClosedCallback,
  ) {
    this.id = id;
    this.host = host;
    if (name !== undefined) this.name = name;
    this.#config = config;
    this.#child = child;
    this.#privateDir = privateDir;
    this.#onClosed = onClosed;

    child.stdout.on("data", (chunk: Buffer) => this.#handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#handleStderr(chunk));
    child.once("error", (error) => this.#handleProcessError(error));
    child.once("exit", (code, signal) => this.#handleExit(code, signal));
  }

  static async open(
    id: string,
    host: string,
    name: string | undefined,
    config: ServerConfig,
    onClosed: SessionClosedCallback,
    onCreated?: SessionCreatedCallback,
  ): Promise<OpenedSession> {
    const token = randomToken();
    const privateDir = `/tmp/.sshmcp-${randomToken()}`;
    const args = [
      "-tt",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `ConnectTimeout=${Math.ceil(config.openTimeoutSec)}`,
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "RemoteCommand=none",
      "-o",
      "SessionType=default",
      "-o",
      "StdinNull=no",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-e",
      "none",
      host,
      "env PS1= PS2= PROMPT_COMMAND= HISTFILE=/dev/null TERM=dumb NO_COLOR=1 CLICOLOR=0 bash --noprofile --norc",
    ];
    const child = spawn(config.sshPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    const session = new SshSession(
      id,
      host,
      name,
      config,
      child,
      privateDir,
      onClosed,
    );
    onCreated?.(session);

    const ready = new Promise<string | undefined>((resolveReady, rejectReady) => {
      session.#openResolve = resolveReady;
      session.#openReject = rejectReady;
    });
    const openTimer = setTimeout(() => {
      session.#failOpen(
        new Error(
          `SSH connection or shell handshake exceeded ${config.openTimeoutSec}s`,
        ),
      );
    }, config.openTimeoutSec * 1_000);
    openTimer.unref();

    child.stdin.write(buildOpenFrame(token, privateDir), (error) => {
      if (error) session.#failOpen(error);
    });
    session.#readyToken = token;

    try {
      const cwd = await ready;
      return cwd === undefined ? { session } : { session, cwd };
    } finally {
      clearTimeout(openTimer);
    }
  }

  #readyToken = "";

  get state(): SessionState {
    return this.#state;
  }

  get lastActivity(): number {
    return this.#lastActivity;
  }

  get cwd(): string | undefined {
    return this.#cwd;
  }

  summary(now = Date.now()): SessionSummary {
    const idleMs =
      this.#state === "idle" ? Math.max(0, now - this.#lastActivity) : 0;
    const summary: SessionSummary = {
      id: this.id,
      host: this.host,
      cwd: this.#cwd,
      status: this.#state === "running" ? "running" : "idle",
      idle_ms: idleMs,
      idle_remaining_ms:
        this.#state === "idle"
          ? Math.max(0, this.#config.idleTimeoutSec * 1_000 - idleMs)
          : this.#config.idleTimeoutSec * 1_000,
      created_at: new Date(this.createdAt).toISOString(),
      last_exit: this.#lastExit,
    };
    if (this.name !== undefined) summary.name = this.name;
    return summary;
  }

  async run(
    command: string,
    timeoutSec?: number,
    waitSec = 10,
  ): Promise<CommandResult> {
    this.#touch();
    if (this.#state === "closed") return this.#goneResult();
    if (this.#active) {
      return {
        id: this.id,
        status: "busy",
        exit_code: null,
        ...this.#snapshot(this.#active, 50),
        cwd: this.#cwd,
        duration_ms: Date.now() - this.#active.startedAt,
        message:
          "this session already has a foreground command; use ssh_peek or ssh_interrupt",
      };
    }

    const token = randomToken();
    const stdout = this.#newOutputBuffer();
    const stderr = this.#newOutputBuffer();
    let resolveCommand!: (result: CommandResult) => void;
    const promise = new Promise<CommandResult>((resolveResult) => {
      resolveCommand = resolveResult;
    });
    const active: ActiveCommand = {
      token,
      parser: new RunFrameParser(token, stdout, stderr),
      stdout,
      stderr,
      startedAt: Date.now(),
      promise,
      resolve: resolveCommand,
      settled: false,
    };
    if (timeoutSec !== undefined) {
      active.timeoutTimer = setTimeout(() => {
        void this.#requestInterrupt("timeout");
      }, timeoutSec * 1_000);
      active.timeoutTimer.unref();
    }
    this.#active = active;
    this.#state = "running";
    const stderrFile = `${this.#privateDir}/${token}.stderr`;

    this.#child.stdin.write(
      buildRunFrame(token, command, stderrFile),
      (error) => {
        if (error) {
          this.#markDead(
            `failed to write command to SSH channel: ${error.message}`,
          );
        }
      },
    );
    if (waitSec === 0) return this.#runningResult(active);
    if (timeoutSec !== undefined && waitSec >= timeoutSec) return promise;

    let waitTimer: NodeJS.Timeout | undefined;
    const waitExpired = new Promise<CommandResult>((resolveWait) => {
      waitTimer = setTimeout(() => {
        resolveWait(this.#runningResult(active));
      }, waitSec * 1_000);
      waitTimer.unref();
    });
    try {
      return await Promise.race([promise, waitExpired]);
    } finally {
      if (waitTimer) clearTimeout(waitTimer);
    }
  }

  async peek(lines = 50, waitSec = 0): Promise<Record<string, unknown>> {
    this.#touch();

    // Long-poll while a foreground command is active so the model does not
    // busy-loop with immediate peeks. Idle sessions return immediately.
    const active = this.#active;
    if (active && waitSec > 0) {
      let waitTimer: NodeJS.Timeout | undefined;
      const waitExpired = new Promise<"expired">((resolve) => {
        waitTimer = setTimeout(() => resolve("expired"), waitSec * 1_000);
        waitTimer.unref();
      });
      try {
        await Promise.race([
          active.promise.then(() => "done" as const),
          waitExpired,
        ]);
      } finally {
        if (waitTimer) clearTimeout(waitTimer);
      }
    }

    return this.#peekSnapshot(lines);
  }

  #peekSnapshot(lines: number): Record<string, unknown> {
    this.#touch();
    if (this.#state === "closed") {
      return {
        id: this.id,
        status: "session_gone",
        message: "unknown or closed session; call ssh_open again",
      };
    }
    if (this.#active) {
      return {
        id: this.id,
        status: "running",
        ...this.#snapshot(this.#active, lines),
        cwd: this.#cwd,
        duration_ms: Date.now() - this.#active.startedAt,
        interrupted: this.#active.interruptReason !== undefined,
      };
    }
    return {
      id: this.id,
      status: "idle",
      cwd: this.#cwd,
      last_exit: this.#lastExit,
      ...(this.#lastResult
        ? {
            stdout: presentOutput(this.#lastResult.stdout, lines),
            stderr: presentOutput(this.#lastResult.stderr, lines),
            truncated: this.#lastResult.truncated,
            stdout_truncated: this.#lastResult.stdout_truncated,
            stderr_truncated: this.#lastResult.stderr_truncated,
          }
        : {}),
    };
  }

  async interrupt(): Promise<CommandResult> {
    this.#touch();
    if (this.#state === "closed") return this.#goneResult();
    if (!this.#active) {
      return {
        id: this.id,
        status: "nothing_to_interrupt",
        exit_code: null,
        stdout: "",
        stderr: "",
        truncated: false,
        stdout_truncated: false,
        stderr_truncated: false,
        cwd: this.#cwd,
        duration_ms: 0,
        message: "session has no foreground command",
      };
    }
    const promise = this.#active.promise;
    await this.#requestInterrupt("interrupted");
    return promise;
  }

  async close(reason = "closed"): Promise<void> {
    if (this.#state === "closed") return;
    this.#closeReason = reason;
    this.#state = "closed";
    if (this.#active && !this.#active.settled) {
      this.#finishAsDead(`session closed while command was running (${reason})`);
    }
    const cleanup = [
      `command rm -rf -- ${shellSingleQuote(this.#privateDir)}`,
      "exit",
      "",
    ].join("\n");
    try {
      this.#child.stdin.end(cleanup);
    } catch {
      // The process exit handler performs the remaining cleanup.
    }
    await this.#terminateAfterGrace();
    this.#notifyClosed();
  }

  #handleStdout(chunk: Buffer): void {
    if (this.#opening) {
      this.#openBuffer = Buffer.concat([this.#openBuffer, chunk]);
      if (this.#openBuffer.length > 1024 * 1024) {
        this.#failOpen(new Error("SSH shell handshake produced more than 1 MiB"));
        return;
      }
      const ready = parseReadyMarker(this.#openBuffer, this.#readyToken);
      if (!ready) return;
      if (ready.exitCode !== 0) {
        this.#failOpen(
          new Error(`failed to create remote private directory (exit ${ready.exitCode})`),
        );
        return;
      }
      this.#opening = false;
      this.#cwd = ready.cwd;
      this.#openBuffer = this.#openBuffer.subarray(ready.consumed);
      this.#openResolve?.(ready.cwd);
      this.#openResolve = undefined;
      this.#openReject = undefined;
      if (this.#openBuffer.length > 0 && this.#active) {
        this.#handleStdout(this.#openBuffer);
      }
      this.#openBuffer = Buffer.alloc(0);
      return;
    }

    const active = this.#active;
    if (!active || active.settled) return;
    const parsed = active.parser.push(chunk);
    if (parsed) this.#completeCommand(active, parsed.exitCode, parsed.cwd);
  }

  #handleStderr(chunk: Buffer): void {
    if (this.#opening) {
      this.#openError.append(chunk);
      return;
    }
    if (this.#active && !this.#active.settled) {
      this.#active.stderr.append(chunk);
    }
  }

  #handleProcessError(error: Error): void {
    if (this.#opening) {
      this.#failOpen(error);
    } else {
      this.#markDead(`SSH process error: ${error.message}`);
    }
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const detail = `SSH process exited${
      code === null ? "" : ` with code ${code}`
    }${signal ? ` (${signal})` : ""}`;
    if (this.#opening) {
      const stderr = this.#openError.toString().trim();
      this.#failOpen(new Error(stderr ? `${detail}: ${stderr}` : detail), false);
      return;
    }
    if (this.#state !== "closed") this.#closeReason = "shell_dead";
    this.#state = "closed";
    this.#finishAsDead(detail);
    this.#notifyClosed();
  }

  #failOpen(error: Error, terminate = true): void {
    if (!this.#opening) return;
    this.#opening = false;
    this.#state = "closed";
    if (terminate) this.#child.kill("SIGTERM");
    this.#openReject?.(error);
    this.#openResolve = undefined;
    this.#openReject = undefined;
    this.#notifyClosed();
  }

  async #requestInterrupt(
    reason: "timeout" | "interrupted",
  ): Promise<void> {
    const active = this.#active;
    if (!active || active.settled) return;
    if (active.interruptReason) return;
    active.interruptReason = reason;
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    this.#child.stdin.write("\x03", (error) => {
      if (error) {
        this.#finishAsDead(`failed to send Ctrl-C: ${error.message}`);
      }
    });
    active.graceTimer = setTimeout(() => {
      if (active.settled) return;
      const result = this.#buildResult(active, {
        status: reason,
        exitCode: null,
        interrupted: true,
        sessionGone: true,
        message:
          "sent SIGINT but the command did not recover before the interrupt grace period; session closed to prevent protocol corruption",
      });
      this.#settle(active, result, false);
      this.#closeReason = `${reason}_unrecoverable`;
      this.#state = "closed";
      this.#child.kill("SIGTERM");
      void this.#terminateAfterGrace();
      this.#notifyClosed();
    }, this.#config.interruptGraceSec * 1_000);
    active.graceTimer.unref();
  }

  #completeCommand(
    active: ActiveCommand,
    exitCode: number,
    cwd: string | undefined,
  ): void {
    if (active.settled) return;
    const status =
      active.interruptReason ?? (exitCode === 0 ? "ok" : "command_failed");
    const message =
      active.interruptReason === "timeout"
        ? "command exceeded timeout_sec; interrupted; session kept; remote side effects may remain — verify before retrying"
        : undefined;
    const result = this.#buildResult(active, {
      status,
      exitCode: active.interruptReason ? null : exitCode,
      interrupted: active.interruptReason !== undefined,
      cwd,
      message,
    });
    this.#cwd = cwd ?? this.#cwd;
    this.#lastExit = exitCode;
    this.#lastResult = result;
    this.#settle(active, result, true);
  }

  #finishAsDead(message: string): void {
    const active = this.#active;
    if (!active || active.settled) return;
    const result = this.#buildResult(active, {
      status: "shell_dead",
      exitCode: null,
      sessionGone: true,
      message,
    });
    this.#settle(active, result, false);
  }

  #markDead(message: string): void {
    if (this.#state === "closed") return;
    this.#closeReason = "shell_dead";
    this.#state = "closed";
    this.#finishAsDead(message);
    this.#child.kill("SIGTERM");
    void this.#terminateAfterGrace();
    this.#notifyClosed();
  }

  #settle(
    active: ActiveCommand,
    result: CommandResult,
    keepSession: boolean,
  ): void {
    if (active.settled) return;
    active.settled = true;
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    if (active.graceTimer) clearTimeout(active.graceTimer);
    if (this.#active === active) this.#active = undefined;
    this.#state = keepSession ? "idle" : "closed";
    this.#touch();
    active.resolve(result);
  }

  #buildResult(
    active: ActiveCommand,
    options: {
      status: CommandResult["status"];
      exitCode: number | null;
      cwd?: string | undefined;
      interrupted?: boolean;
      sessionGone?: boolean;
      message?: string | undefined;
      lines?: number | undefined;
    },
  ): CommandResult {
    const result: CommandResult = {
      id: this.id,
      status: options.status,
      exit_code: options.exitCode,
      ...this.#snapshot(active, options.lines),
      cwd: options.cwd ?? this.#cwd,
      duration_ms: Date.now() - active.startedAt,
    };
    if (options.interrupted !== undefined) {
      result.interrupted = options.interrupted;
    }
    if (options.sessionGone !== undefined) {
      result.session_gone = options.sessionGone;
    }
    if (options.message !== undefined) result.message = options.message;
    return result;
  }

  #runningResult(active: ActiveCommand): CommandResult {
    return this.#buildResult(active, {
      status: "running",
      exitCode: null,
      lines: 50,
      message:
        "command is still running in this session; do not retry it—poll ssh_peek, use ssh_interrupt to stop it, or open another session for concurrent work",
    });
  }

  #snapshot(active: ActiveCommand, lines?: number): OutputSnapshot {
    return {
      stdout: presentOutput(active.stdout.toString(), lines),
      stderr: presentOutput(active.stderr.toString(), lines),
      truncated: active.stdout.truncated || active.stderr.truncated,
      stdout_truncated: active.stdout.truncated,
      stderr_truncated: active.stderr.truncated,
    };
  }

  #goneResult(): CommandResult {
    return {
      id: this.id,
      status: "session_gone",
      exit_code: null,
      stdout: "",
      stderr: "",
      truncated: false,
      stdout_truncated: false,
      stderr_truncated: false,
      cwd: this.#cwd,
      duration_ms: 0,
      session_gone: true,
      message: "unknown or closed session; call ssh_open again",
    };
  }

  #newOutputBuffer(): HeadTailBuffer {
    return new HeadTailBuffer(
      this.#config.outputMaxBytes,
      this.#config.outputHeadBytes,
    );
  }

  #touch(): void {
    this.#lastActivity = Date.now();
  }

  async #terminateAfterGrace(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const softTimer = setTimeout(() => this.#child.kill("SIGTERM"), 500);
    softTimer.unref();
    const hardTimer = setTimeout(() => this.#child.kill("SIGKILL"), 2_000);
    hardTimer.unref();
    try {
      await Promise.race([
        once(this.#child, "exit"),
        new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, 2_500);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
    }
  }

  #notifyClosed(): void {
    if (this.#closedNotified) return;
    this.#closedNotified = true;
    this.#onClosed(this, this.#closeReason);
  }
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}
