#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runInit } from "./cli/init.js";
import { createServer } from "./server.js";
import { logger } from "./util/logger.js";

const USAGE = `@engine-room/after-effects-mcp — drive Adobe After Effects from an AI agent.

With no arguments it runs as an MCP server over stdio, which is how an MCP
client (Claude Code, Claude Desktop, …) starts it. You do not normally run it
by hand.

Commands:
  init <directory> [--no-mcp]   Create a project folder containing the client
                                configuration and a house-style skill you can
                                edit. Pass --no-mcp if your client already
                                provides these tools.
  --help                        Show this message.
  --version                     Print the version.
`;

async function main() {
  const argv = process.argv.slice(2);

  // CLI modes short-circuit before the stdio transport exists, so writing to
  // stdout here cannot corrupt the JSON-RPC stream.
  if (argv[0] === "init") {
    process.exit(runInit(argv.slice(1)));
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (argv.length > 0) {
    process.stderr.write(`Unknown command: ${argv[0]}\n\n${USAGE}`);
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server running on stdio");
  exitWhenStdinCloses(() => server.close());
}

/**
 * stdin closing is how a stdio MCP client says it has gone (issue #163). The
 * transport does not act on it, and the event socket to the panel kept the
 * event loop alive, so every client that quit without signalling left an
 * orphaned server holding a WebSocket to After Effects. Closing the server
 * stops that socket (server.ts), a running render is stopped by its own stdin
 * hook (render/aerender.ts), and the process then ends because nothing is left
 * to run. Deliberately not `process.exit`: called after a fetch it crashes
 * Node 24 on Windows. A terminal's stdin is never the client, so it is left
 * alone. Nothing here writes stdout.
 */
function exitWhenStdinCloses(close: () => Promise<void>): void {
  if (process.stdin.isTTY) return;
  let leaving = false;
  const leave = () => {
    if (leaving) return;
    leaving = true;
    logger.info("stdin closed: the MCP client has gone; shutting down.");
    process.exitCode = 0;
    close().catch((e) => logger.warn(`closing the server failed: ${(e as Error).message}`));
    // Unref'd, so it never holds the process open; it fires only if something
    // else still does, and then says so rather than leaving a silent orphan.
    setTimeout(() => {
      logger.warn("still running 10s after stdin closed — a handle is holding the event loop open; exiting.");
      process.exit(0);
    }, 10_000).unref();
  };
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);
}

const VERSION = "0.5.2";

main().catch((e) => {
  logger.error("fatal", (e as Error).message);
  process.exit(1);
});
