import { displayOp } from "./opNames.js";
export class BridgeUnreachableError extends Error {
  constructor(public port: number, cause?: Error) {
    super(BridgeUnreachableError.message(port, cause));
    this.name = "BridgeUnreachableError";
  }
  static message(port: number, cause?: Error): string {
    return [
      `Cannot reach the After Effects panel at http://127.0.0.1:${port}.`,
      cause ? `Underlying error: ${cause.message}` : "",
      "",
      "Call the check_setup tool to find out why, then relay its nextSteps to the user.",
      "In most cases the fix is either installing the panel (quit After Effects, run",
      "setup_panel, then reopen it) or simply opening After Effects.",
    ].filter(Boolean).join("\n");
  }
}

/**
 * The panel answered, and what it answered was "no" — one of the five bridge
 * failures, whose remedy contradicts the other four (see docs/fragile-areas-bridge.md).
 * `sentToken` splits it: nothing sent means this server cannot see the panel's
 * token file; sent and rejected means the file outlived the panel that wrote it.
 */
export class BridgeAuthError extends Error {
  constructor(public port: number, public sentToken: boolean) {
    super(BridgeAuthError.message(port, sentToken));
    this.name = "BridgeAuthError";
  }
  static message(port: number, sentToken: boolean): string {
    return [
      `The After Effects panel on port ${port} refused this call: the bridge token did not match.`,
      "",
      "This is not a lost connection and not a busy bridge. The panel is running and",
      "answered immediately — it answered by refusing. The call never reached After",
      "Effects, so nothing in the project changed and nothing needs undoing.",
      "",
      "The panel requires a token because the bridge is an HTTP server on 127.0.0.1, and",
      "loopback is not a boundary a browser respects: without it, any page open in the",
      "user's browser could drive After Effects. The panel writes the token beside its",
      `port file, at ${tokenFileHint(port)}, every time it binds.`,
      "",
      "What to do, in order:",
      ...(sentToken
        ? [
            "1. This server did send a token and the panel rejected it, so the file it read",
            "   belongs to a panel that is no longer the one answering — usually a previous",
            "   After Effects session whose panel process outlived it.",
            "2. Quit After Effects completely and reopen it. That rebinds the panel and",
            "   rewrites the token, and the next call succeeds.",
            "3. If it persists, check for a leftover CEPHtmlEngine in Activity Monitor or",
            "   Task Manager holding the port — the same zombie issue #92 is about.",
          ]
        : [
            "1. This server found no token file for that port, so it sent none. Either the",
            "   panel could not write it — its own log in After Effects says so — or this",
            "   server and the panel disagree about where home is, which happens when the",
            "   MCP client runs the server sandboxed or as a different user.",
            "2. Ask the user to look at the panel in After Effects (Window > Extensions).",
            "   It logs the exact path it wrote the token to when it starts.",
            "3. If the panel never started, run check_setup and relay its nextSteps.",
          ]),
      "",
      "Do NOT re-send this call until the cause is fixed; it will be refused identically.",
      "Running setup_panel does not help: this is not a broken install.",
    ].join("\n");
  }
}

/** Duplicated rather than imported from discovery.ts, which imports this module. */
function tokenFileHint(port: number): string {
  return `${process.platform === "win32" ? "%USERPROFILE%\\.engineroom-ae-mcp\\token-" : "~/.engineroom-ae-mcp/token-"}${port}`;
}

/**
 * What a timed-out tool call cost, measured by the server. `totalMs` runs
 * from the moment the tool was called; `gateMs` (the panel-version check) and
 * `queueMs` (this session's write queue) are the two earlier steps measured
 * directly. They need not add up to the rest of `totalMs`.
 */
export interface TimeoutTiming { totalMs: number; gateMs: number; queueMs: number; }

/** "3s", "0.3s" — a limit as the reader set it. */
function secondsText(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
}

/** "5.0s" under ten seconds, whole seconds above — a measured span. */
function elapsedText(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/**
 * The parts of the earlier time that were measured directly, or "" when none
 * was long enough to mention. Deliberately not a breakdown that sums: other
 * earlier steps go unitemised — `render_queue`'s prepare round trip before its
 * save, a refused attempt and the port search before a re-send — and naming any
 * of them as one of these would be false.
 */
function measuredBeforeText(t: TimeoutTiming): string {
  const parts: string[] = [];
  if (t.gateMs >= 250) parts.push(`${elapsedText(t.gateMs)} checking the panel's version (a probe that waits on a busy After Effects too)`);
  if (t.queueMs >= 250) parts.push(`${elapsedText(t.queueMs)} waiting behind this session's own earlier write`);
  return parts.length ? ` Of that, ${parts.join(" and ")}.` : "";
}

/** What may still happen after the timeout — which, for render_queue, is little. */
function landingLines(step: "prepare" | "save" | undefined): string[] {
  const another = [
    "One possible reason for the wait is another MCP client connected to the same After",
    "Effects, since the panel runs one call at a time for every client; this message",
    "cannot tell which.",
  ];
  if (step === "prepare") {
    return [
      "Nothing was saved and no render was started: this step only reads the render",
      "queue, so nothing can land from it.",
      ...another,
    ];
  }
  if (step === "save") {
    return [
      "No render was started. Only the project save may still complete after this",
      "message — it reached After Effects and nothing cancels it. Calling render_queue",
      "again is safe: a second save of the same project changes nothing.",
      ...another,
    ];
  }
  return [
    "The call may still run and land after this message: it reached the panel, or is",
    "queued there, and nothing cancels it. That has been measured — a write that timed",
    "out this way appeared in the comp once After Effects was free.",
    ...another,
  ];
}

/**
 * The panel accepted the connection and then did not answer in time.
 *
 * This is a completely different diagnosis from a refused connection and must
 * never share a sentence with it. ExtendScript is single-threaded: while After
 * Effects is busy running a script — or sitting on a modal dialog nobody has
 * clicked — it cannot service the panel's socket at all, so a busy AE is
 * indistinguishable from a dead one at the HTTP layer. Reported as issue #26,
 * where a `run_jsx` loop over `app.effects` produced "the bridge is down" for a
 * bridge that came back on its own a minute later.
 *
 * The whole point of this message is to stop the reader restarting things that
 * do not need restarting.
 */
/**
 * `renderStep` marks a timeout in one of `render_queue`'s two bridge steps,
 * which escape before any render starts: the prepare only reads, and only the
 * save can still land. The generic "may still land, do not re-send" is false
 * for both, and `_render_save` is a name no agent ever called.
 */
export interface TimeoutOpts { op?: string; adjustable?: boolean; timing?: TimeoutTiming; renderStep?: "prepare" | "save"; }

export class BridgeTimeoutError extends Error {
  constructor(
    public port: number,
    public timeoutMs: number,
    public opts: TimeoutOpts = {}
  ) {
    super(BridgeTimeoutError.message(port, timeoutMs, opts));
    this.name = "BridgeTimeoutError";
  }

  /**
   * Restate the message with what the whole tool call cost, not just the op's
   * own limit (issue #175). The limit starts when the request is sent; before
   * that the call can spend time on the panel-version check (its own 2s probe,
   * which waits on a busy After Effects like anything else) and in this
   * session's write queue. Measured on 26.5: a 3s limit was reported to the
   * agent after 5.0s, and "did not answer within 3s" was the only number it saw.
   */
  withTiming(timing: TimeoutTiming): this {
    this.opts = { ...this.opts, timing };
    this.message = BridgeTimeoutError.message(this.port, this.timeoutMs, this.opts);
    return this;
  }

  /** Restate the message as a timeout in `render_queue`'s prepare or save step. */
  asRenderStep(step: "prepare" | "save"): this {
    this.opts = { ...this.opts, op: "render_queue", renderStep: step };
    this.message = BridgeTimeoutError.message(this.port, this.timeoutMs, this.opts);
    return this;
  }

  static message(
    port: number,
    timeoutMs: number,
    opts: TimeoutOpts = {}
  ): string {
    const secs = secondsText(timeoutMs);
    const what = opts.op ? `\`${displayOp(opts.op)}\`` : "the call";
    const t = opts.timing;
    // Only worth a sentence when the call visibly outlasted its limit; a few
    // hundred milliseconds of scheduling is not a story.
    const before = t ? Math.max(0, t.totalMs - timeoutMs) : 0;
    const head =
      t && before >= 500
        ? [
            `The After Effects panel at http://127.0.0.1:${port} did not answer ${what} in time: this tool call gave up ${elapsedText(t.totalMs)} after it was made.`,
            `The op's own limit is ${secs} and starts only when its request is sent; the other ${elapsedText(before)} went on earlier steps of this call.${measuredBeforeText(t)}`,
          ]
        : [`The After Effects panel at http://127.0.0.1:${port} did not answer within ${secs} for ${what}.`];
    return [
      ...head,
      "",
      "This is a timeout, not a lost connection — the panel is very probably still",
      "there. ExtendScript is single-threaded, so while After Effects is busy running a",
      "script it cannot answer the bridge at all, and a busy AE looks exactly like a",
      "dead one from here. It usually recovers on its own.",
      "",
      ...landingLines(opts.renderStep),
      "",
      "What to do, in order:",
      ...(opts.renderStep
        ? [
            "1. Do not restart After Effects, and do not run setup_panel. Once check_setup",
            "   shows the panel answering, call render_queue again — that starts the render.",
          ]
        : [
            "1. Do not restart After Effects, and do not run setup_panel. Do not re-send the",
            "   call either — that would queue a second copy of the same work.",
          ]),
      "2. Call check_setup, and keep polling it for about a minute. The bridge normally",
      "   comes back by itself once the script finishes. While nothing has answered since,",
      "   check_setup names this call under `busyWith` — a long script can hold After",
      "   Effects for minutes, and that is the sign to keep waiting rather than diagnose.",
      "3. Ask the user to look at After Effects. A modal dialog — an unsaved-project",
      "   prompt, a missing-font warning — blocks it in the same way and may be hidden",
      "   behind another window. Only they can click it.",
      "4. On macOS, if they have switched to another desktop (Space), ask them to switch",
      "   back to the one After Effects is on. Calls have been reported to stall until",
      "   they return, then complete normally.",
      "5. Only if check_setup still reports the bridge down after a minute, with no",
      "   `busyWith`, should you treat this as a real disconnection and follow its nextSteps.",
      opts.adjustable === false
        ? ""
        : `\nIf this work legitimately takes longer than ${secs}, the limit is settable: start the\nserver with AE_MCP_OP_TIMEOUT_MS set to a larger number of milliseconds.`,
    ].filter(Boolean).join("\n");
  }
}

/**
 * The panel accepted the connection and then dropped it before answering —
 * `ECONNRESET`, or undici's "other side closed" (issue #163).
 *
 * Deliberately not a `BridgeUnreachableError`. A refusal means the request never
 * reached a panel, so `runOp` may look for the panel elsewhere and re-send; a
 * reset means it did reach one, mid-request, and may have run. Re-sending that
 * is the duplicated-side-effect bug a timeout already guards against (#43). Nor
 * is it a timeout: nothing is still running and waiting changes nothing — the
 * usual cause is the panel or After Effects going away under the call (a quit,
 * a crash, a `/reload-jsx`, the CEP engine being recycled).
 */
export class BridgeResetError extends Error {
  constructor(public port: number, public op: string | undefined, cause?: Error) {
    super(BridgeResetError.message(port, op, cause));
    this.name = "BridgeResetError";
  }
  static message(port: number, op?: string, cause?: Error): string {
    const what = op ? `\`${displayOp(op)}\`` : "the call";
    return [
      `The After Effects panel at http://127.0.0.1:${port} dropped the connection in the middle of ${what}.`,
      cause ? `Underlying error: ${errorChainText(cause)}` : "",
      "",
      "The request was delivered before the connection broke, so it may or may not have",
      "taken effect — no answer came back to say which. This is neither a panel that",
      "was never there nor one still working on the call.",
      "",
      "What to do, in order:",
      "1. Do not blindly re-send it. A write could land twice.",
      "2. Confirm the panel is back with check_setup; if it reports a problem, relay",
      "   what it says to the user.",
      "3. Once it answers, read the affected comp or layer back (diff_comp against a",
      "   snapshot, get_layer_full, list_layers) to learn whether this call landed,",
      "   and only send it again if it did not.",
    ].filter(Boolean).join("\n");
  }
}

/** `TypeError: fetch failed` hides the useful part on `cause`; print the chain. */
function errorChainText(e: Error): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur && typeof cur === "object" && i < 4; i++) {
    const m = (cur as { message?: unknown }).message;
    if (typeof m === "string" && m && !parts.includes(m)) parts.push(m);
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
  return parts.join(": ");
}

/**
 * True when a `fetch` rejection is a connection the panel accepted and then
 * dropped, rather than one it refused. Node's fetch wraps the socket error on
 * `cause`; undici reports a peer close as `UND_ERR_SOCKET` ("other side
 * closed") and the kernel's as `ECONNRESET`. Matched by code, never by text.
 *
 * A failure that proves the request was never delivered is NOT a reset, even
 * when it is wrapped in one — see `isUnsentError`, which is checked first.
 */
export function isResetError(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 4) return false;
  const code = (e as { code?: unknown }).code;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return true;
  const cause = (e as { cause?: unknown }).cause;
  return cause === e ? false : isResetError(cause, depth + 1);
}

/**
 * True when a `fetch` rejection proves the request did not reach a panel
 * whole, so nothing can have run — the same footing as a refusal, and safe to
 * classify as unreachable (and so re-sendable).
 *
 * `EPIPE` is a failed *write*: the socket was already closed when the request
 * was being sent — typically a keep-alive socket the panel had dropped while it
 * sat idle. The panel runs an op only on the request's `end` event, after the
 * whole body has arrived (`req.on("end")` in client/main.js), so a request
 * whose write failed cannot have run. `ECONNRESET` and `UND_ERR_SOCKET` prove
 * no such thing — fetch does not say whether the body had been written, or
 * whether the socket was a reused one — so they stay resets, may-have-run.
 */
export function isUnsentError(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 4) return false;
  const code = (e as { code?: unknown }).code;
  if (code === "EPIPE") return true;
  const cause = (e as { cause?: unknown }).cause;
  return cause === e ? false : isUnsentError(cause, depth + 1);
}

/**
 * True when a `fetch` rejection came from an AbortSignal timeout rather than a
 * refused or dropped connection.
 *
 * Node's fetch rejects with a `TimeoutError` DOMException for
 * `AbortSignal.timeout`, but an aborted request can also surface as
 * `AbortError`, and either can arrive wrapped in a `TypeError: fetch failed`
 * with the real reason on `cause`. Check the name at every level rather than
 * matching on message text, which is not stable across runtimes.
 */
export function isTimeoutError(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 4) return false;
  const name = (e as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const cause = (e as { cause?: unknown }).cause;
  return cause === e ? false : isTimeoutError(cause, depth + 1);
}

/**
 * Where a failure sits in the script the caller actually submitted.
 *
 * Only `run_jsx` can produce this, because it is the only op whose input is
 * source code. `sourceLine` is null whenever the mapping could not be made —
 * it is never clamped into range, since a confident wrong line number sends the
 * reader to a statement that did not fail. See issue #46 and `raw.jsx`.
 */
export interface AeSourceInfo {
  /** 1-based line in the caller's own script, or null when it could not be mapped. */
  sourceLine?: number | null;
  /** The text of that line, trimmed and clipped. The part that needs no trust in numbering. */
  sourceText?: string | null;
  /**
   * The file the reported line belongs to: the caller's `scriptPath`, or the
   * library the failure landed in when one was inlined ahead of the script.
   */
  sourceName?: string | null;
  /** What After Effects itself reported, kept because the mapping can fail. */
  rawLine?: number | null;
  /** Lines in the submitted script, which is what makes an out-of-range number visible. */
  lineCount?: number | null;
}

export class AeError extends Error {
  /**
   * `code` is set only when the panel diagnosed the failure itself rather than
   * relaying one from ExtendScript — `STALE_FRAME` is the first. Those messages
   * already read as complete instructions, so the caller uses this to decide
   * whether an `AE:` prefix would help or just obscure them.
   */
  constructor(
    message: string,
    public stack_?: string,
    public line?: number,
    public code?: string,
    public source?: AeSourceInfo
  ) {
    super(message);
    this.name = "AeError";
  }
}

/**
 * The one rendering of an ExtendScript failure into text for the agent.
 *
 * A bare line number was actively misleading: it counts from something the
 * caller cannot see, and there is no rollback, so an agent that mislocates the
 * throw re-runs a script whose first half already landed (issues #43, #46).
 * Three things earn their place here — the line's *text*, which needs no trust
 * in the numbering; an explicit admission when the number could not be mapped;
 * and the reminder that the work before the failure is still in the project.
 */
export function aeErrorText(e: AeError): string {
  const head = `AE: ${e.message}`;
  const s = e.source;
  if (!s) return e.line ? `${head} (line ${e.line})` : head;

  const where = s.sourceName ?? "the script you submitted";
  const total = s.lineCount ? `, ${s.lineCount} lines` : "";
  const lines = [head];
  if (s.sourceLine) {
    lines.push(`  at line ${s.sourceLine} of ${where}${total}:`);
    if (s.sourceText) lines.push(`    ${s.sourceText}`);
    // Only worth saying when the two disagree. Without `libraries` the
    // wrapper's preamble is zero lines and they do not; with them, the shift is
    // the library source inlined ahead of the script, and showing both numbers
    // is what lets a reader see that rather than doubt the mapped one.
    if (s.rawLine != null && s.rawLine !== s.sourceLine) {
      lines.push(`  (After Effects reported line ${s.rawLine}.)`);
    }
  } else if (s.rawLine != null) {
    lines.push(
      `  After Effects reported line ${s.rawLine}, which does not fall inside ${where}${total} — trust the message, not the number.`
    );
  }
  lines.push(
    "  Everything before the failure already ran and nothing rolls back: read the state back rather than re-running the script."
  );
  return lines.join("\n");
}

/**
 * The third case, and it must not be read as either of the first two.
 *
 * `BridgeUnreachableError` means the panel is not there. `BridgeTimeoutError`
 * means it is there and busy — and it forbids re-sending, because the call did
 * reach After Effects and may still be running. This one is the opposite of
 * both: the call never left the server, nothing was written, and re-sending is
 * the correct next move once the queue drains. Collapsing it into the timeout
 * message would tell the reader not to re-send work that never happened, and
 * collapsing it into the unreachable message would send them off restarting a
 * bridge that is answering perfectly well.
 */
export class WriteQueueWaitError extends Error {
  constructor(public op: string, public waitedMs: number, public behind: string, public confirmation?: string) {
    super(WriteQueueWaitError.message(op, waitedMs, behind, confirmation));
    this.name = "WriteQueueWaitError";
  }
  static message(op: string, waitedMs: number, behind: string, confirmation?: string): string {
    const secs = Math.round(waitedMs / 1000);
    return [
      `\`${displayOp(op)}\` waited ${secs}s behind \`${displayOp(behind)}\` for the After Effects write queue and was dropped without running.`,
      // Its clock was stopped while that op waited on a person (issue #245),
      // so the seconds above are all spent on work, never on the dialog.
      ...(confirmation
        ? [
            `It also waited while \`${displayOp(confirmation)}\` waited for the user to answer a confirmation prompt; that time is not`,
            "counted in the figure above.",
          ]
        : []),
      "",
      "This is neither a lost connection nor a busy bridge. The panel is fine and this",
      "call never reached After Effects, so nothing in the project was changed.",
      "",
      "Writes are serialized because After Effects runs one script at a time and applies",
      "changes in the order it receives them; two in flight block each other and land in",
      "an order nobody chose. Something in front of this call is taking a very long time",
      "— most often a long run_batch, occasionally a modal dialog in After Effects",
      "blocking the script in front.",
      "",
      "What to do, in order:",
      "1. Nothing was written, so re-sending this call is safe — unlike a bridge timeout.",
      "   Wait for the work in front to finish first, or it will just queue again.",
      "2. Find out what is in front: get_job or await_job for a batch. Reads are not",
      "   queued, so list_/get_ calls still work and will tell you the current state.",
      "3. Ask the user to look at After Effects for a dialog nobody has clicked.",
      `4. If the work in front is legitimately this long, raise the limit: start the`,
      "   server with AE_MCP_WRITE_QUEUE_WAIT_MS set to a larger number of milliseconds.",
    ].join("\n");
  }
}

/** Backpressure, so a client that fires writes in a loop cannot grow the queue without bound. */
export class WriteQueueFullError extends Error {
  constructor(public op: string, public maxDepth: number, public behind: string, public confirmation?: string) {
    super(WriteQueueFullError.message(op, maxDepth, behind, confirmation));
    this.name = "WriteQueueFullError";
  }
  static message(op: string, maxDepth: number, behind: string, confirmation?: string): string {
    return [
      `The After Effects write queue is full — ${maxDepth} calls are already waiting, so \`${displayOp(op)}\` was refused.`,
      "",
      `Nothing was written. Writes are serialized so they land in the order you sent them,`,
      confirmation
        ? `and \`${displayOp(confirmation)}\` is holding the queue up while it waits for the user to answer a confirmation prompt — ask them to answer it.`
        : `and \`${displayOp(behind)}\` is holding the queue up.`,
      "",
      "Stop issuing writes and let it drain — reads are not queued, so list_/get_ calls",
      "still work. If you have this much independent work to do, send it as one",
      "run_batch instead of as many calls: that is one ExtendScript pass and one place in",
      "the queue, and its result reports how many undo steps it actually made.",
      "AE_MCP_WRITE_QUEUE_DEPTH raises the limit if you really need it raised.",
    ].join("\n");
  }
}

/**
 * The request was cancelled while its write was still queued.
 *
 * Reported rather than swallowed: the client has usually stopped listening by
 * now, but if it has not, "this never ran" is the one thing it needs to know.
 */
export class WriteQueueCancelledError extends Error {
  constructor(public op: string) {
    super(`\`${displayOp(op)}\` was cancelled while waiting for the After Effects write queue. It never ran, and nothing was changed.`);
    this.name = "WriteQueueCancelledError";
  }
}

/**
 * Fields a tool once declared and no longer takes, with where the work went.
 * The generic unknown-field text says "check the spelling", which is wrong
 * advice for a key that is spelt right and simply lives on another tool.
 */
const SHAPE_LAYER_EMPTY =
  "create_shape_layer only creates the empty layer — create it without this, then draw into it with " +
  "add_shape_content (a group, then a rect/ellipse/path, then a {type:\"fill\", color} or " +
  "{type:\"stroke\", color, width} inside the group)";
export const REMOVED_FIELD_HINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Issue #148: declared, never applied, so a filled shape came back empty.
  create_shape_layer: {
    fill: SHAPE_LAYER_EMPTY,
    stroke: SHAPE_LAYER_EMPTY,
    strokeWidth: SHAPE_LAYER_EMPTY,
    shapes: SHAPE_LAYER_EMPTY,
  },
};

/**
 * A rejected tool call, said in sentences.
 *
 * `ZodError.message` is `JSON.stringify(issues, null, 2)` — an array of objects
 * with `code`, `expected`, `received` and a `path` array, wrapped around the one
 * sentence worth reading. Every carefully written cross-field message in
 * `schemas.ts` arrived buried in that, and the machine-readable parts say
 * nothing an agent can act on that the prose does not.
 *
 * Same rule the rest of this file follows for After Effects' own errors: an
 * agent can only correct a failure it is told about, so the message names the
 * field and says what to pass. Anything that is not a `ZodError` passes through
 * untouched — this must never swallow an error whose shape it does not know.
 */
export function invalidArgsText(op: string, e: unknown): string {
  const issues = (e as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return `Invalid arguments for ${op}: ${(e as Error).message}`;
  }
  const lines = issues.map((raw) => {
    const issue = raw as {
      path?: unknown[];
      message?: string;
      code?: string;
      expected?: string;
      received?: string;
    };
    const where = Array.isArray(issue.path) && issue.path.length ? issue.path.join(".") : null;
    // A custom message is the whole reason for writing one, so it wins. The
    // type-error forms are rebuilt because zod's own reads "Required" with the
    // field name only in `path`, which is exactly the half that used to be lost.
    // zod 4 issues carry no `received` field; the received type is only in the
    // message ("Invalid input: expected string, received undefined").
    let text = issue.message ?? "invalid";
    const received = issue.received ?? /received (\w+)\s*$/.exec(issue.message ?? "")?.[1];
    const unknownKeys = (raw as { keys?: unknown }).keys;
    // A union's own message is "Invalid input", whatever went wrong. When only
    // one branch was the right type and failed on something else — a hex
    // string with an alpha against a colour that is an RGB array or a hex —
    // that branch's message is the one that says how to fix it (issue #170).
    const branches = (raw as { errors?: unknown }).errors;
    if (issue.code === "invalid_union" && Array.isArray(branches)) {
      const typed = (branches as { code?: string; path?: unknown[]; message?: string }[][]).filter(
        (b) => Array.isArray(b) && b.length > 0 && !b.some((i) => i.code === "invalid_type" && !(i.path && i.path.length))
      );
      if (typed.length === 1) text = typed[0].map((i) => i.message ?? "invalid").join("; ");
    }
    if (issue.code === "unrecognized_keys" && Array.isArray(unknownKeys)) {
      // Refused rather than stripped (issue #147): a key the tool does not know
      // is one it would have ignored while reporting success.
      const hints = REMOVED_FIELD_HINTS[op] ?? {};
      const hinted = unknownKeys.filter((k) => Object.hasOwn(hints, String(k)));
      const plain = unknownKeys.filter((k) => !Object.hasOwn(hints, String(k)));
      const parts: string[] = [];
      if (plain.length > 0) {
        const names = plain.map((k) => "`" + String(k) + "`").join(", ");
        parts.push(
          `${plain.length === 1 ? "unknown field" : "unknown fields"} ${names}: not part of this tool's arguments, ` +
          `so ${plain.length === 1 ? "it" : "they"} would have been ignored. Check the spelling against the tool's schema.`
        );
      }
      // Grouped by hint, so four removed fields sharing one remedy say it once.
      const byHint = new Map<string, string[]>();
      for (const k of hinted) {
        const h = hints[String(k)];
        byHint.set(h, [...(byHint.get(h) ?? []), "`" + String(k) + "`"]);
      }
      for (const [h, names] of byHint) {
        parts.push(`${op} does not take ${names.join(", ")}: ${h}.`);
      }
      text = parts.join(" ");
    } else if (issue.code === "invalid_type" && received === "undefined") {
      text = "required, and was not passed";
    } else if (issue.code === "invalid_type" && issue.expected) {
      text = `expected ${issue.expected}, got ${received ?? "something else"}`;
    }
    return where ? `  - ${where}: ${text}` : `  - ${text}`;
  });
  const head =
    issues.length === 1
      ? `Invalid arguments for ${op}:`
      : `Invalid arguments for ${op} (${issues.length} problems):`;
  return [head, ...lines].join("\n");
}

/**
 * A write-queue wait that ran out behind *another session's* write (issue #223).
 *
 * Still a `WriteQueueWaitError` — the same kind, with the same remedy: nothing
 * ran, so re-sending is safe. What changes is the honest half of the story.
 * The work in front belongs to another AI session on the same After Effects,
 * so `get_job` and `await_job` cannot see it, and the user is the one who can
 * decide which session should give way.
 */
export class DeskWaitError extends WriteQueueWaitError {
  constructor(op: string, waitedMs: number, behind: string, public behindSession: string) {
    super(op, waitedMs, behind);
    this.name = "DeskWaitError";
    this.message = DeskWaitError.text(op, waitedMs, behind, behindSession);
  }
  static text(op: string, waitedMs: number, behind: string, behindSession: string): string {
    const secs = Math.round(waitedMs / 1000);
    return [
      `\`${displayOp(op)}\` waited ${secs}s behind another session's \`${displayOp(behind)}\` (${behindSession}) for the After Effects write queue and was dropped without running.`,
      "",
      "Another AI session is connected to the same After Effects, and its writes and",
      "this session's writes take turns. This call never reached After Effects, so",
      "nothing in the project was changed.",
      "",
      "What to do, in order:",
      "1. Nothing was written, so re-sending this call is safe — unlike a bridge timeout.",
      "   Let the other session's work finish first, or it will just queue again.",
      "2. get_job and await_job only know this session's own jobs, so they cannot show",
      "   the other session's work. Reads are not queued: list_/get_ calls still work.",
      "3. Tell the user another session is writing to the same After Effects, and ask",
      "   whether to wait for it or to stop one of the two.",
      "4. If that work is legitimately this long, raise the limit: start the server with",
      "   AE_MCP_WRITE_QUEUE_WAIT_MS set to a larger number of milliseconds.",
    ].join("\n");
  }
}

/**
 * The front desk went away after it had handed a call to After Effects (issue #223).
 *
 * A reset in every sense that matters — the call reached AE and may have run —
 * so it is one, and `server.ts` handles it as one. Only the first paragraph
 * differs, because the thing that dropped the connection is the other server
 * process that was running the desk, not the panel, and "confirm the panel is
 * back" would send the reader to check something that never left.
 */
export class FrontDeskLostError extends BridgeResetError {
  constructor(port: number, op: string, how: "exited" | "stalled" = "exited") {
    super(port, op);
    this.name = "FrontDeskLostError";
    this.message = FrontDeskLostError.text(op, how);
  }
  static text(op: string, how: "exited" | "stalled" = "exited"): string {
    const what =
      how === "stalled"
        ? "stopped answering in the middle of `" + displayOp(op) + "` — the server process running it is suspended or hung."
        : "went away in the middle of `" + displayOp(op) + "` — the server process running it exited.";
    return [
      `The front desk this session shares with other AI sessions on the same After Effects ${what}`,
      "",
      "The call had reached the desk, which may already have handed it to After Effects,",
      "so it may or may not have taken effect; no answer came back to say which. The",
      "next call goes through whichever server holds the desk then, or straight to",
      "After Effects if none answers.",
      "",
      "It may also land LATER: a call already on its way to After Effects can still",
      "arrive after this message — after a read-back that did not find it.",
      "",
      "What to do, in order:",
      "1. Do not blindly re-send it. A write could land twice.",
      "2. Read the affected comp or layer back (diff_comp against a snapshot,",
      "   get_layer_full, list_layers) to learn whether this call landed.",
      "3. If it did not and you send it again, read back once more afterwards before",
      "   assuming there is only one copy — or first wait until another call has gone",
      "   through, which means the old desk is out of the way, then read back.",
    ].join("\n");
  }
}

/**
 * A write that never left this server because its place in the shared write
 * queue was lost (issue #223): the front desk stopped answering before granting
 * it, or changed hands and the lease could not be re-taken. Nothing reached
 * After Effects. The write-queue-wait kind — re-sending is safe — so it is one.
 */
export class DeskPlaceLostError extends WriteQueueWaitError {
  constructor(op: string, public why: string) {
    super(op, 0, "the front desk");
    this.name = "DeskPlaceLostError";
    this.message = DeskPlaceLostError.text(op, why);
  }
  static text(op: string, why: string): string {
    return [
      `\`${displayOp(op)}\` was not sent: ${why}`,
      "",
      "Several AI sessions share this After Effects through a front desk run by one of",
      "their servers, and this call's place in the shared write queue is gone. It never",
      "reached After Effects, so nothing in the project was changed.",
      "",
      "What to do, in order:",
      "1. Nothing was written, so re-sending this call is safe — unlike a bridge timeout.",
      "2. If it fails the same way again, tell the user another AI session's server has",
      "   stopped responding (a suspended terminal, a debugger) and ask them to resume or",
      "   close it; within seconds this session goes to After Effects directly instead.",
    ].join("\n");
  }
}

/**
 * A script that never left this server because the viewer park sent ahead of
 * it got no answer in time (issue #266). After Effects is busy — the park
 * reached it and may still land — but the script itself was never sent, so
 * this is the write-queue-wait kind: re-sending is safe once After Effects
 * answers. Never the timeout's wording, whose remedy (do not re-send) is the
 * opposite of this one.
 */
export class ScriptNotSentError extends WriteQueueWaitError {
  /**
   * `check`: "park" for the park itself; "dry-run" for the dry-run park sent
   * ahead of a script that reads activeItem, which never creates the parking
   * comp or parks the viewer, so its wording says only what it can do (#277).
   */
  constructor(op: string, what?: string, check: "park" | "dry-run" = "park") {
    super(op, 0, "the viewer park");
    this.name = "ScriptNotSentError";
    this.message = ScriptNotSentError.text(op, what, check);
  }
  static text(op: string, what?: string, check: "park" | "dry-run" = "park"): string {
    const head = `${what ?? "`" + displayOp(op) + "`"} was not sent`;
    const busy = [
      "After Effects is very probably still on earlier work — a long script, a render started in After Effects, another AI",
      "session's call, or a dialog nobody has clicked.",
      "",
      "What to do, in order:",
      "1. Poll check_setup until After Effects answers again. If the earlier work is a call this session made, check_setup",
      "   names it under `busyWith`; a render, another session's call or a dialog it cannot name, and says only that it is busy.",
      "2. Then send this same call again: the script was never run, so sending it again is safe.",
    ];
    if (check === "dry-run") {
      return [
        `${head}: After Effects did not answer the viewer check that goes ahead of a script reading app.project.activeItem, so it is busy.`,
        "",
        "The script never reached After Effects, so none of it ran. The check creates nothing and parks nothing; if it lands",
        "late, the most it does is reopen the user's comp in the viewer in place of a park an earlier call left behind.",
        "Nothing in the project can change.",
        ...busy,
      ].join("\n");
    }
    return [
      `${head}: After Effects did not answer the viewer park that goes ahead of the script, so it is busy.`,
      "",
      "The script never reached After Effects, so none of it ran. The park itself did reach After Effects and may still",
      "land late: it switches the viewer to an empty comp named \"AE MCP viewer parking (safe to delete)\" — and, if that",
      "comp does not exist yet, first creates it at the project root as one undo step of its own. Nothing else in the project can change.",
      ...busy,
      "3. If the viewer shows that parking comp meanwhile, that is the park landing late; the next run_jsx or check_setup",
      "   puts the user's comp back. The comp itself is AE MCP's, reused by every later run, and safe to delete.",
    ].join("\n");
  }
}

/**
 * A background read that asked to yield to writes found one in progress, in
 * this session or — through the front desk — in any session, and was not sent
 * (issue #248). Never shown to an agent: the live-resource poll that sends
 * such reads skips the tick and tries again later.
 */
export class BridgeBusyError extends Error {
  /**
   * `otherSession`: the write in the way is another session's, seen at the
   * front desk — the one sign this session gets that someone else is editing
   * the project (the poll walks the summary once afterwards).
   */
  constructor(public op: string, public holder?: string, why?: string, public otherSession = false) {
    super(
      why
        ? `\`${op}\` was not sent: ${why}.`
        : `\`${op}\` was not sent: ${holder ? `\`${holder}\`` : "a write"} holds the After Effects write lock, and this read yields to writes.`
    );
    this.name = "BridgeBusyError";
  }
}
