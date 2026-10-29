// MCP's stdio framing: one JSON-RPC message per line, UTF-8, no embedded
// newlines (JSON.stringify never emits one). Pure — tested offline in
// tests/unit/live-driver.mjs.

/** One message, ready to write to the server's stdin. */
export function encodeMessage(msg) {
  return JSON.stringify(msg) + "\n";
}

/**
 * Splits a byte stream into messages. Chunks arrive cut anywhere — mid-line,
 * mid-character, several messages at once — so bytes are held until a newline
 * completes a line, and decoded only then (a multi-byte character split across
 * two chunks would otherwise become two replacement characters).
 *
 * A line that is not JSON is handed to `onNoise` rather than thrown: the
 * server's stdout is sacred (CLAUDE.md), so a stray line there is a finding the
 * driver reports, not a reason to lose the rest of the run.
 */
export class LineDecoder {
  constructor({ onMessage, onNoise = () => {} }) {
    this.onMessage = onMessage;
    this.onNoise = onNoise;
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    let nl;
    while ((nl = this.pending.indexOf(0x0a)) >= 0) {
      const line = this.pending.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      this.pending = this.pending.subarray(nl + 1);
      this.#line(line);
    }
  }

  /** Whatever is left when the stream closes without a final newline. */
  end() {
    if (this.pending.length) {
      const line = this.pending.toString("utf8").replace(/\r$/, "");
      this.pending = Buffer.alloc(0);
      this.#line(line);
    }
  }

  #line(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onNoise(line);
      return;
    }
    if (msg === null || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      this.onNoise(line);
      return;
    }
    this.onMessage(msg);
  }
}

/**
 * A tool result as the driver reads it. The server answers every op with a
 * first text block holding JSON (`textResult` in server.ts); screenshots add an
 * image block after it, and a queued write on a non-object result adds a second
 * text block carrying the wait. Errors are a single text block with isError.
 */
export function readToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const texts = content.filter((c) => c.type === "text").map((c) => c.text);
  const images = content.filter((c) => c.type === "image");
  const text = texts[0] ?? "";
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const extra = texts.slice(1).map((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  });
  return { isError: result?.isError === true, text, json, extra, images };
}
