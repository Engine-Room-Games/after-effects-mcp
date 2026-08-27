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
      "In most cases the fix is either running setup_panel (installs the panel) or",
      "simply opening After Effects.",
    ].filter(Boolean).join("\n");
  }
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
export class BridgeTimeoutError extends Error {
  constructor(
    public port: number,
    public timeoutMs: number,
    opts: { op?: string; adjustable?: boolean } = {}
  ) {
    super(BridgeTimeoutError.message(port, timeoutMs, opts));
    this.name = "BridgeTimeoutError";
  }
  static message(
    port: number,
    timeoutMs: number,
    opts: { op?: string; adjustable?: boolean } = {}
  ): string {
    const secs = Math.round(timeoutMs / 1000);
    const what = opts.op ? `\`${opts.op}\`` : "the call";
    return [
      `The After Effects panel at http://127.0.0.1:${port} did not answer within ${secs}s for ${what}.`,
      "",
      "This is a timeout, not a lost connection — the panel is very probably still",
      "there. ExtendScript is single-threaded, so while After Effects is busy running a",
      "script it cannot answer the bridge at all, and a busy AE looks exactly like a",
      "dead one from here. It usually recovers on its own.",
      "",
      "What to do, in order:",
      "1. Do not restart After Effects, and do not run setup_panel. Do not re-send the",
      "   call either — that would queue a second copy of the same work.",
      "2. Call check_setup, and keep polling it for about a minute. The bridge normally",
      "   comes back by itself once the script finishes.",
      "3. Ask the user to look at After Effects. A modal dialog — an unsaved-project",
      "   prompt, a missing-font warning — blocks it in the same way and may be hidden",
      "   behind another window. Only they can click it.",
      "4. On macOS, if they have switched to another desktop (Space), ask them to switch",
      "   back to the one After Effects is on. Calls have been reported to stall until",
      "   they return, then complete normally.",
      "5. Only if check_setup still reports the bridge down after a minute should you",
      "   treat this as a real disconnection and follow its nextSteps.",
      opts.adjustable === false
        ? ""
        : `\nIf this work legitimately takes longer than ${secs}s, the limit is settable: start the\nserver with AE_MCP_OP_TIMEOUT_MS set to a larger number of milliseconds.`,
    ].filter(Boolean).join("\n");
  }
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

export class AeError extends Error {
  constructor(message: string, public stack_?: string, public line?: number) {
    super(message);
    this.name = "AeError";
  }
}
