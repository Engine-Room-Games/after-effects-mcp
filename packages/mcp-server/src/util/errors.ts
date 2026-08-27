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

export class AeError extends Error {
  /**
   * `code` is set only when the panel diagnosed the failure itself rather than
   * relaying one from ExtendScript — `STALE_FRAME` is the first. Those messages
   * already read as complete instructions, so the caller uses this to decide
   * whether an `AE:` prefix would help or just obscure them.
   */
  constructor(message: string, public stack_?: string, public line?: number, public code?: string) {
    super(message);
    this.name = "AeError";
  }
}
