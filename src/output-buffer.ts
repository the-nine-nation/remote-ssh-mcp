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
