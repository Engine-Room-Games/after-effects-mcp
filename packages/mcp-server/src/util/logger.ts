// All logs go to stderr — stdout is reserved for the MCP stdio transport.

export const logger = {
  info: (...a: unknown[]) => console.error("[ae-mcp]", ...a),
  warn: (...a: unknown[]) => console.error("[ae-mcp:warn]", ...a),
  error: (...a: unknown[]) => console.error("[ae-mcp:error]", ...a),
  debug: (...a: unknown[]) => {
    if (process.env.AE_MCP_DEBUG) console.error("[ae-mcp:debug]", ...a);
  },
};
