import { Buffer } from "node:buffer";
import type { HeadTailBuffer } from "./output-buffer.js";

export function shellSingleQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("commands cannot contain NUL bytes");
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildOpenFrame(token: string, privateDir: string): string {
  const quotedDir = shellSingleQuote(privateDir);
  return [
    "command stty -echo -onlcr",
    "builtin umask 077",
    `command mkdir -m 700 -- ${quotedDir}`,
    "__sshmcp_open_rc=$?",
    "__sshmcp_open_cwd=$(builtin printf '%s' \"$PWD\" | command base64 | command tr -d '\\r\\n')",
    `builtin printf '\\n__SSHMCP_READY:%s:${token}:%s__\\n' "$__sshmcp_open_rc" "$__sshmcp_open_cwd"`,
    "",
  ].join("\n");
}

export function buildRunFrame(
  token: string,
  command: string,
  stderrFile: string,
): string {
  const quotedCommand = shellSingleQuote(command);
  const quotedFile = shellSingleQuote(stderrFile);
  const rcVariable = `__sshmcp_rc_${token}`;
  const cwdVariable = `__sshmcp_cwd_${token}`;
  return [
    `: > ${quotedFile}`,
    `builtin eval -- ${quotedCommand} </dev/null 2>${quotedFile}`,
    `${rcVariable}=$?`,
    `${cwdVariable}=$(builtin printf '%s' "$PWD" | command base64 | command tr -d '\\r\\n')`,
    `builtin printf '\\n__SSHMCP_EXIT:%s:${token}:%s__\\n' "$${rcVariable}" "$${cwdVariable}"`,
    `builtin printf '__SSHMCP_ERR_BEGIN:${token}__\\n'`,
    `command cat -- ${quotedFile}`,
    `command rm -f -- ${quotedFile}`,
    `builtin printf '\\n__SSHMCP_ERR_END:${token}__\\n'`,
    `builtin unset ${rcVariable} ${cwdVariable}`,
    "",
  ].join("\n");
}

export interface ParsedFrame {
  exitCode: number;
  cwd?: string;
}

type ParserStage = "stdout" | "exit_line" | "err_begin" | "stderr" | "done";

export class RunFrameParser {
  readonly #token: string;
  readonly #stdout: HeadTailBuffer;
  readonly #stderr: HeadTailBuffer;
  readonly #exitPrefix: Buffer;
  readonly #errBegin: Buffer;
  readonly #errEnd: Buffer;
  #stage: ParserStage = "stdout";
  #pending = Buffer.alloc(0);
  #parsed?: ParsedFrame;

  constructor(token: string, stdout: HeadTailBuffer, stderr: HeadTailBuffer) {
    this.#token = token;
    this.#stdout = stdout;
    this.#stderr = stderr;
    this.#exitPrefix = Buffer.from("\n__SSHMCP_EXIT:");
    this.#errBegin = Buffer.from(`__SSHMCP_ERR_BEGIN:${token}__\n`);
    this.#errEnd = Buffer.from(`\n__SSHMCP_ERR_END:${token}__\n`);
  }

  push(chunk: Buffer): ParsedFrame | undefined {
    if (this.#stage === "done" || chunk.length === 0) return this.#parsed;
    this.#pending = Buffer.concat([this.#pending, chunk]);

    while (true) {
      if (this.#stage === "stdout") {
        const index = this.#pending.indexOf(this.#exitPrefix);
        if (index < 0) {
          this.#flushSafe(this.#stdout, this.#exitPrefix.length - 1);
          return undefined;
        }
        this.#stdout.append(this.#pending.subarray(0, index));
        this.#pending = this.#pending.subarray(index + 1);
        this.#stage = "exit_line";
        continue;
      }

      if (this.#stage === "exit_line") {
        const lineEnd = this.#pending.indexOf(0x0a);
        if (lineEnd < 0) return undefined;
        const line = this.#pending.subarray(0, lineEnd).toString("utf8").replace(/\r$/, "");
        const match = new RegExp(
          `^__SSHMCP_EXIT:(-?\\d+):${this.#token}:([A-Za-z0-9+/=]*)__$`,
        ).exec(line);
        if (!match) {
          this.#stdout.append(Buffer.from("\n"));
          this.#stdout.append(this.#pending.subarray(0, lineEnd + 1));
          this.#pending = this.#pending.subarray(lineEnd + 1);
          this.#stage = "stdout";
          continue;
        }
        const exitCode = Number.parseInt(match[1] ?? "1", 10);
        const cwd = decodeBase64(match[2] ?? "");
        this.#parsed = cwd === undefined ? { exitCode } : { exitCode, cwd };
        this.#pending = this.#pending.subarray(lineEnd + 1);
        this.#stage = "err_begin";
        continue;
      }

      if (this.#stage === "err_begin") {
        const index = this.#pending.indexOf(this.#errBegin);
        if (index < 0) {
          this.#flushSafe(this.#stdout, this.#errBegin.length - 1);
          return undefined;
        }
        this.#stdout.append(this.#pending.subarray(0, index));
        this.#pending = this.#pending.subarray(index + this.#errBegin.length);
        this.#stage = "stderr";
        continue;
      }

      if (this.#stage === "stderr") {
        const index = this.#pending.indexOf(this.#errEnd);
        if (index < 0) {
          this.#flushSafe(this.#stderr, this.#errEnd.length - 1);
          return undefined;
        }
        this.#stderr.append(this.#pending.subarray(0, index));
        this.#pending = this.#pending.subarray(index + this.#errEnd.length);
        this.#stage = "done";
        return this.#parsed;
      }

      return this.#parsed;
    }
  }

  #flushSafe(target: HeadTailBuffer, keepBytes: number): void {
    if (this.#pending.length <= keepBytes) return;
    const flushLength = this.#pending.length - keepBytes;
    target.append(this.#pending.subarray(0, flushLength));
    this.#pending = this.#pending.subarray(flushLength);
  }
}

export function parseReadyMarker(
  input: Buffer,
  token: string,
): { consumed: number; exitCode: number; cwd?: string } | undefined {
  // With ssh -tt, the open frame is often fully echoed before `stty -echo`
  // takes effect. That echo includes the printf template containing a
  // literal `__SSHMCP_READY:` prefix. Skip non-matching occurrences so a
  // later real marker is still found.
  const marker = Buffer.from(`__SSHMCP_READY:`);
  const readyLine = new RegExp(
    `^__SSHMCP_READY:(-?\\d+):${token}:([A-Za-z0-9+/=]*)__$`,
  );
  let searchFrom = 0;
  while (searchFrom <= input.length) {
    const start = input.indexOf(marker, searchFrom);
    if (start < 0) return undefined;
    const end = input.indexOf(0x0a, start);
    if (end < 0) return undefined;
    const line = input.subarray(start, end).toString("utf8").replace(/\r$/, "");
    const match = readyLine.exec(line);
    if (!match) {
      searchFrom = start + marker.length;
      continue;
    }
    const exitCode = Number.parseInt(match[1] ?? "1", 10);
    const cwd = decodeBase64(match[2] ?? "");
    return cwd === undefined
      ? { consumed: end + 1, exitCode }
      : { consumed: end + 1, exitCode, cwd };
  }
  return undefined;
}

function decodeBase64(value: string): string | undefined {
  try {
    if (value.length === 0) return "";
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      return undefined;
    }
    return decoded.toString("utf8");
  } catch {
    return undefined;
  }
}
