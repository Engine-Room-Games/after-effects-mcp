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
}

const VERSION = "0.3.0";

main().catch((e) => {
  logger.error("fatal", (e as Error).message);
  process.exit(1);
});
