export type SessionState = "idle" | "running" | "closed";

export type CommandStatus =
  | "ok"
  | "command_failed"
  | "timeout"
  | "interrupted"
  | "busy"
  | "session_gone"
  | "shell_dead"
  | "nothing_to_interrupt";

export interface OutputSnapshot {
  stdout: string;
  stderr: string;
  truncated: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface CommandResult extends OutputSnapshot {
  id: string;
  status: CommandStatus;
  exit_code: number | null;
  cwd?: string | undefined;
  duration_ms: number;
  interrupted?: boolean;
  session_gone?: boolean;
  message?: string | undefined;
}

export interface SessionSummary {
  id: string;
  host: string;
  name?: string;
  cwd?: string | undefined;
  status: Exclude<SessionState, "closed">;
  idle_ms: number;
  idle_remaining_ms: number;
  created_at: string;
  last_exit: number | null;
}

export interface ServerConfig {
  allowedHosts: ReadonlySet<string>;
  allowedHostsSource: string[];
  sshPath: string;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  openTimeoutSec: number;
  idleTimeoutSec: number;
  interruptGraceSec: number;
  maxSessions: number;
  outputMaxBytes: number;
  outputHeadBytes: number;
  auditLogPath: string;
}

export interface AuditEvent {
  event: "open" | "run" | "interrupt" | "close" | "idle_reap" | "shell_dead";
  id: string;
  host: string;
  name?: string | undefined;
  status: string;
  duration_ms?: number | undefined;
  exit_code?: number | null | undefined;
  command_length?: number | undefined;
  command_sha256?: string | undefined;
  command_name?: string | undefined;
  message?: string | undefined;
}
