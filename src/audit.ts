import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent } from "./types.js";

export class AuditLogger {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async write(event: AuditEvent): Promise<void> {
    const record = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await appendFile(this.#path, record, { encoding: "utf8", mode: 0o600 });
      await chmod(this.#path, 0o600);
    } catch (error) {
      console.error(`remote-ssh-mcp: unable to write audit log: ${errorMessage(error)}`);
    }
  }
}

export function commandAuditFields(command: string): Pick<
  AuditEvent,
  "command_length" | "command_sha256" | "command_name"
> {
  const commandName = command
    .trimStart()
    .match(/^(?:builtin\s+|command\s+|sudo\s+)?([A-Za-z0-9_./-]+)/)?.[1]
    ?.slice(0, 80);
  return {
    command_length: Buffer.byteLength(command),
    command_sha256: createHash("sha256").update(command).digest("hex"),
    ...(commandName === undefined ? {} : { command_name: commandName }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
