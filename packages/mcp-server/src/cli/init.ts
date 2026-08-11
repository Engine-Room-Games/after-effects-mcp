import path from "node:path";
import { ClientKind, ScaffoldError, scaffold } from "../setup/scaffold.js";

/**
 * `npx @engine-room/after-effects-mcp init <dir>` — scaffold a working folder
 * for one video, series or client.
 *
 * This is the terminal path, kept for people who prefer it. The same scaffold is
 * available as the `init_project` tool, which is how everyone else gets it:
 * add the server to your client, then ask it to set up a project. Both call
 * `scaffold()`, so there is one definition of what a project folder is.
 */

const KNOWN_FLAGS = ["--no-mcp", "--with-mcp"];
const CLIENTS: ClientKind[] = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "vscode",
  "windsurf",
  "codex",
  "generic",
];

export interface InitOptions {
  dir: string;
  withMcp: boolean;
  client: ClientKind;
}

export function parseInitArgs(argv: string[]): InitOptions | { error: string } {
  const positional: string[] = [];
  let withMcp = true;
  let client: ClientKind = "claude-code";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-mcp") withMcp = false;
    else if (arg === "--with-mcp") withMcp = true;
    else if (arg === "--client" || arg.startsWith("--client=")) {
      const value = arg.startsWith("--client=") ? arg.slice("--client=".length) : argv[++i];
      if (!value) return { error: "--client needs a value." };
      if (!CLIENTS.includes(value as ClientKind)) {
        return { error: `Unknown client "${value}". One of: ${CLIENTS.join(", ")}.` };
      }
      client = value as ClientKind;
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    } else positional.push(arg);
  }

  if (positional.length === 0) return { error: "Missing target directory." };
  if (positional.length > 1) return { error: `Expected one directory, got ${positional.length}.` };
  return { dir: positional[0]!, withMcp, client };
}

export function runInit(argv: string[]): number {
  const parsed = parseInitArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(
      `${parsed.error}\n\n` +
        `Usage: npx @engine-room/after-effects-mcp init <directory> [--no-mcp] [--client <name>]\n` +
        `       clients: ${CLIENTS.join(", ")} (default claude-code)\n`
    );
    return 1;
  }

  let result;
  try {
    result = scaffold({
      dir: parsed.dir,
      client: parsed.client,
      withMcpConfig: parsed.withMcp,
    });
  } catch (e) {
    if (e instanceof ScaffoldError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }

  // Safe to write to stdout: this path never starts the stdio MCP server.
  const lines = [`Created ${result.dir}`, ``];
  for (const rel of result.written) {
    if (rel.endsWith(".gitkeep")) lines.push(`  ${pad(path.dirname(rel) + "/")} exports land here`);
    else if (rel === "AGENTS.md") lines.push(`  ${pad(rel)} what this project is`);
    else if (rel.endsWith("mcp.json")) lines.push(`  ${pad(rel)} connects your client to After Effects`);
    else lines.push(`  ${pad(rel)} points your client at AGENTS.md`);
  }
  lines.push(``, `Next:`);
  lines.push(`  1. Open the folder in your AI client:  cd ${parsed.dir}`);
  result.nextSteps.forEach((s, i) => lines.push(`  ${i + 2}. ${s}`));
  if (result.mcpConfigHint) {
    lines.push(
      ``,
      `${parsed.client} configures servers globally rather than per folder. Add this to`,
      `${result.mcpConfigHint.path}:`,
      ``,
      result.mcpConfigHint.json.trimEnd()
    );
  }
  lines.push(``);
  process.stdout.write(lines.join("\n"));
  return 0;
}

function pad(s: string): string {
  return s.padEnd(38);
}
