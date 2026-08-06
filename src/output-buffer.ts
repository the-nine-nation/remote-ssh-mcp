/**
 * Keeps the beginning and end of a byte stream without ever retaining more
 * than maxBytes. Decoding happens only when a response is built, so truncation
 * never emits a partial UTF-8 code point.
 */
export class HeadTailBuffer {
  readonly #maxBytes: number;
  readonly #headBytes: number;
  readonly #tailBytes: number;
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #totalBytes = 0;

  constructor(maxBytes: number, headBytes: number) {
    if (maxBytes < 1 || headBytes < 0 || headBytes > maxBytes) {
      throw new Error("invalid head/tail buffer limits");
    }
    this.#maxBytes = maxBytes;
    this.#headBytes = headBytes;
    this.#tailBytes = maxBytes - headBytes;
  }

  append(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (bytes.length === 0) return;
    this.#totalBytes += bytes.length;

    let offset = 0;
    if (this.#head.length < this.#headBytes) {
      const take = Math.min(this.#headBytes - this.#head.length, bytes.length);
      this.#head = Buffer.concat([this.#head, bytes.subarray(0, take)]);
      offset = take;
    }

    if (offset < bytes.length && this.#tailBytes > 0) {
      this.#tail = Buffer.concat([this.#tail, bytes.subarray(offset)]);
      if (this.#tail.length > this.#tailBytes) {
        this.#tail = this.#tail.subarray(this.#tail.length - this.#tailBytes);
      }
    }
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get truncated(): boolean {
    return this.#totalBytes > this.#maxBytes;
  }

  toString(): string {
    const head = trimIncompleteUtf8End(this.#head).toString("utf8");
    const tail = trimIncompleteUtf8End(
      trimUtf8ContinuationStart(this.#tail),
    ).toString("utf8");
    const separator = this.truncated
      ? `\n… [${this.#totalBytes - this.#head.length - this.#tail.length} bytes truncated] …\n`
      : "";
    return `${head}${separator}${tail}`;
  }
}

/**
 * Strip VT/ANSI control sequences that PTY-backed shells and CLIs inject
 * (bracketed paste, colors, cursor motion, OSC titles, …).
 */
export function stripAnsi(input: string): string {
  if (input.length === 0) return input;
  return (
    input
      // OSC: ESC ] … BEL | ST
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // DCS / PM / APC / SOS: ESC P|X|^|_ … ST (best-effort)
      .replace(/\u001b[PX^_][^\u001b]*(?:\u001b\\)?/g, "")
      // CSI: ESC [ … final (@–~), including ?2004h / colors / cursor
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // Charset designation: ESC ( B, ESC ) 0, …
      .replace(/\u001b[()][0-9A-Za-z]/g, "")
      // Two-byte ESC sequences (e.g. ESC = / ESC > application keypad)
      .replace(/\u001b[=>NOE78McZc]/g, "")
      // Any remaining ESC + one byte (keep payload usable even if exotic)
      .replace(/\u001b./g, "")
  );
}

/**
 * Prepare terminal output for model consumption:
 * strip ANSI, apply CR overwrite, drop control-only noise lines,
 * collapse blank-line runs, remove other C0 controls (keep tab/newline).
 */
export function sanitizeForModel(input: string): string {
  if (input.length === 0) return "";

  let text = stripAnsi(input);
  // Drop other C0 controls except TAB / LF / CR (CR handled next).
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  text = text.replace(/\r\n/g, "\n");

  // Within each logical line, treat CR as "overwrite from column 0".
  text = text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");

  const hasTrailingNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (hasTrailingNewline) rawLines.pop();

  // Drop blank lines entirely: after ANSI strip they are almost always
  // control-only noise (e.g. bracketed-paste CSI on its own line), and
  // keeping them burns the model's `lines` budget.
  const kept = rawLines.filter((line) => line.trim().length > 0);
  if (kept.length === 0) return "";
  const result = kept.join("\n");
  return hasTrailingNewline ? `${result}\n` : result;
}

/**
 * Present raw buffered stream text to the model: sanitize first, then
 * optionally keep only the newest `lines` lines (counted after sanitize).
 */
export function presentOutput(input: string, lines?: number): string {
  const clean = sanitizeForModel(input);
  if (lines === undefined) return clean;
  return latestLines(clean, lines);
}

export function latestLines(input: string, count: number): string {
  if (count <= 0 || input.length === 0) return "";
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const hasTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hasTrailingNewline) lines.pop();
  const result = lines.slice(-count).join("\n");
  return hasTrailingNewline && result.length > 0 ? `${result}\n` : result;
}

function trimUtf8ContinuationStart(buffer: Buffer): Buffer {
  let start = 0;
  while (
    start < buffer.length &&
    buffer[start] !== undefined &&
    (buffer[start]! & 0xc0) === 0x80
  ) {
    start += 1;
  }
  return buffer.subarray(start);
}

function trimIncompleteUtf8End(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  let leadIndex = buffer.length - 1;
  while (
    leadIndex >= 0 &&
    buffer[leadIndex] !== undefined &&
    (buffer[leadIndex]! & 0xc0) === 0x80
  ) {
    leadIndex -= 1;
  }
  if (leadIndex < 0) return Buffer.alloc(0);
  const lead = buffer[leadIndex]!;
  const expected =
    (lead & 0x80) === 0
      ? 1
      : (lead & 0xe0) === 0xc0
        ? 2
        : (lead & 0xf0) === 0xe0
          ? 3
          : (lead & 0xf8) === 0xf0
            ? 4
            : 1;
  const actual = buffer.length - leadIndex;
  return actual < expected ? buffer.subarray(0, leadIndex) : buffer;
}
