export class BridgeUnreachableError extends Error {
  constructor(public port: number, cause?: Error) {
    super(BridgeUnreachableError.message(port, cause));
    this.name = "BridgeUnreachableError";
  }
  static message(port: number, cause?: Error): string {
    return [
      `Cannot reach the After Effects MCP panel at http://127.0.0.1:${port}.`,
      cause ? `Underlying error: ${cause.message}` : "",
      "",
      "Fix:",
      "  1. Open After Effects 2026.",
      "  2. Ensure PlayerDebugMode is on:",
      "       defaults write com.adobe.CSXS.12 PlayerDebugMode 1",
      "     (Restart AE after toggling — and reboot once if it doesn't take.)",
      "  3. Install the panel (one-time):",
      "       npm run install:panel",
      "     This symlinks packages/ae-panel into",
      "     ~/Library/Application Support/Adobe/CEP/extensions/com.engineroom.ae-mcp/",
      "  4. The panel auto-loads on AE launch. To force-show for debugging:",
      "       Window > Extensions > AE MCP Bridge",
    ].filter(Boolean).join("\n");
  }
}

export class AeError extends Error {
  constructor(message: string, public stack_?: string, public line?: number) {
    super(message);
    this.name = "AeError";
  }
}
