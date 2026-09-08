import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageVersion } from "./paths.js";

/**
 * The project scaffold, shared by the `init_project` tool and the
 * `npx @engine-room/after-effects-mcp init` command.
 *
 * The server writes these files itself rather than telling the agent to write
 * them. That is the whole reason this works outside Claude Code: Claude Desktop
 * gives its agent no filesystem tools at all, so any design where the *agent*
 * creates the folder is dead there. A tool call needs nothing from the client.
 *
 * What lands on disk is deliberately thin. The house style is not here — it
 * lives beside the .aep and is read over the bridge (see packages/jsx/style.jsx),
 * so it reaches clients that cannot read files. The tool knowledge is not here
 * either; it ships with the server as guides. What remains is the part that is
 * genuinely about *this user's project* and is theirs to edit.
 */

export type ClientKind =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "codex"
  | "generic";

export interface ScaffoldOptions {
  /** Explicit target. Relative paths resolve against the server's working directory. */
  dir?: string;
  name?: string;
  /** "auto" is resolved by the caller before it gets here. */
  client: ClientKind;
  withMcpConfig: boolean;
  /** Roots the client advertised, best first. Used only when `dir` is absent. */
  roots?: string[];
}

export interface ScaffoldResult {
  dir: string;
  name: string;
  client: ClientKind;
  /** Repo-relative paths that were created, in write order. */
  written: string[];
  /** Where the target came from, so the agent can say so rather than implying certainty. */
  resolvedFrom: "argument" | "client-root" | "working-directory";
  /** Present when the client has no project-scoped config file to write. */
  mcpConfigHint?: { path: string; json: string };
  nextSteps: string[];
}

/** Thrown when there is no defensible place to write. The message is read by the user. */
export class ScaffoldError extends Error {}

/**
 * Identify the client from the MCP handshake so the right files get written
 * without asking the user which tool they are sitting in. Substring matching:
 * these strings carry version suffixes and casing varies between releases.
 */
export function detectClient(clientName: string | undefined): ClientKind {
  const n = (clientName ?? "").toLowerCase();
  if (!n) return "generic";
  if (n.includes("claude-code") || n.includes("claude code")) return "claude-code";
  // Claude Desktop and the web client both identify as claude-ai.
  if (n.includes("claude-ai") || n.includes("claude desktop")) return "claude-desktop";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("windsurf") || n.includes("codeium")) return "windsurf";
  if (n.includes("codex")) return "codex";
  if (n.includes("visual studio code") || n.includes("vscode") || n.includes("copilot")) return "vscode";
  return "generic";
}

const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "@engine-room/after-effects-mcp"],
};

/** Where each client keeps project-scoped MCP config, and in which dialect. */
function mcpConfigFor(client: ClientKind): { rel: string; json: string } | undefined {
  const standard = JSON.stringify({ mcpServers: { "after-effects": MCP_SERVER_ENTRY } }, null, 2) + "\n";
  switch (client) {
    case "claude-code":
      return { rel: ".mcp.json", json: standard };
    case "cursor":
      return { rel: path.join(".cursor", "mcp.json"), json: standard };
    case "vscode":
      // VS Code uses `servers`, not `mcpServers`; the standard key is ignored.
      return {
        rel: path.join(".vscode", "mcp.json"),
        json: JSON.stringify({ servers: { "after-effects": { type: "stdio", ...MCP_SERVER_ENTRY } } }, null, 2) + "\n",
      };
    default:
      // Claude Desktop, Codex and Windsurf configure servers globally, not per
      // folder. Writing a file into the project would be cargo cult.
      return undefined;
  }
}

/** The global config path to tell the user about when there is no project file. */
function globalConfigHint(client: ClientKind): { path: string; json: string } | undefined {
  const standard = JSON.stringify({ mcpServers: { "after-effects": MCP_SERVER_ENTRY } }, null, 2) + "\n";
  const home = os.homedir();
  switch (client) {
    case "claude-desktop":
      return {
        path:
          process.platform === "darwin"
            ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
            : path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json"),
        json: standard,
      };
    case "windsurf":
      return { path: path.join(home, ".codeium", "windsurf", "mcp_config.json"), json: standard };
    case "codex":
      return {
        path: path.join(home, ".codex", "config.toml"),
        json: '[mcp_servers.after-effects]\ncommand = "npx"\nargs = ["-y", "@engine-room/after-effects-mcp"]\n',
      };
    default:
      return undefined;
  }
}

/**
 * The line in a project's docs that records which release of these tools the
 * project has been brought up to date with. The absorb-release prompt greps for
 * the prefix, reads `ae_guide({topic: "whats-new", since: <that version>})`,
 * rewrites whatever the release superseded in the project's own notes, and
 * moves the version on — so the history is read once per release per project
 * and never again. Human-readable on purpose: designers open AGENTS.md in a
 * text editor, and a line they can read is one they will leave alone.
 */
export const ABSORBED_MARKER_PREFIX = "Tools version last absorbed:";
const ABSORBED_MARKER = new RegExp(`^\\s*${ABSORBED_MARKER_PREFIX}\\s*v?(\\d+\\.\\d+\\.\\d+)\\s*$`, "m");

export function absorbedMarkerLine(version: string): string {
  return `${ABSORBED_MARKER_PREFIX} ${version}`;
}

/** The version a project doc records as absorbed, or null when it carries no marker. */
export function absorbedVersionIn(text: string): string | null {
  const m = ABSORBED_MARKER.exec(text);
  return m ? m[1]! : null;
}

const AGENTS_MD = (name: string, version: string) => `# ${name}

An After Effects project folder. The AE tools drive After Effects directly from
here — describe what you want and it gets built in the open project.

## How to work in this folder

1. Open After Effects with the project you want to work on.
2. Say what you want in plain language — "build a lower third that says Chapter
   One and slides in from the left".
3. The current state of the comp is read, the change is made, and you see it.

## Style

The look of everything built here comes from \`house-style.md\`, which sits next
to the After Effects project file itself. Ask for a style guide and one gets
written from a comp you already like; edit it in any text editor afterwards.

It travels with the .aep, so it applies wherever the project is opened.

## When a tool misbehaves

Check \`list_known_issues\` before guessing — an earlier session may already have
solved it. Anything newly worked out goes in with \`log_issue\`, and the
report-ae-issue prompt sends it to the maintainers.

## Tool updates

${absorbedMarkerLine(version)}

When the After Effects tools update, the absorb-release prompt reads what
changed since the version above, fixes any rule in this folder the update made
stale, and moves the version on. Leave the line where it is.

## Conventions for this project

<!-- Anything specific to this project rather than to your general style: naming
     conventions for comps and layers, delivery specs, the client's
     requirements, what lives in which comp. -->

- Renders go in \`renders/\`.
`;

/**
 * Clients that read their own rules file get a pointer, not a second copy —
 * two descriptions of the same project drift apart within a week.
 */
function pointerContent(rel: string): string {
  const body = `# After Effects project

See [AGENTS.md](AGENTS.md) for how this folder works, and \`house-style.md\`
beside the .aep for the look everything should follow.
`;
  // Cursor only applies an .mdc rule when its frontmatter says to.
  if (rel.endsWith(".mdc")) {
    return `---\ndescription: How this After Effects project folder works\nalwaysApply: true\n---\n\n${body}`;
  }
  return body;
}

function pointerFiles(client: ClientKind): string[] {
  switch (client) {
    case "claude-code":
      return ["CLAUDE.md"];
    case "cursor":
      return [path.join(".cursor", "rules", "after-effects.mdc")];
    case "windsurf":
      return [".windsurfrules"];
    case "vscode":
      return [path.join(".github", "copilot-instructions.md")];
    default:
      // Codex, Claude Desktop and anything unrecognised read AGENTS.md or
      // nothing at all; a pointer file would just be litter.
      return [];
  }
}

/**
 * Decide where the project goes.
 *
 * Order matters: an explicit argument is the user's own words, a client root is
 * the folder they have open, and the working directory is a guess that is only
 * safe when it is clearly a real project folder. Claude Desktop starts servers
 * at `/`, so the last one has to be able to refuse.
 */
export function resolveTarget(
  dir: string | undefined,
  roots: string[] | undefined
): { dir: string; resolvedFrom: ScaffoldResult["resolvedFrom"] } {
  if (dir && dir.trim().length > 0) {
    return refuseUnscoped({ dir: path.resolve(dir.trim()), resolvedFrom: "argument" });
  }

  const root = roots?.find((r) => r && r.trim().length > 0);
  if (root) return refuseUnscoped({ dir: path.resolve(root), resolvedFrom: "client-root" });

  const cwd = process.cwd();
  return refuseUnscoped({ dir: cwd, resolvedFrom: "working-directory" });
}

/**
 * The filesystem root and the home directory are never a project folder,
 * whichever way they were arrived at. Claude Desktop starts servers at `/`,
 * and an agent that resolves `~` or passes the folder it happens to be in can
 * hand either one over as an explicit `dir` — scaffolding AGENTS.md and a
 * renders/ folder into someone's home directory is never what anyone meant.
 */
function refuseUnscoped(target: { dir: string; resolvedFrom: ScaffoldResult["resolvedFrom"] }) {
  const { dir, resolvedFrom } = target;
  const isFilesystemRoot = dir === path.parse(dir).root;
  if (!isFilesystemRoot && dir !== os.homedir()) return target;
  const how =
    resolvedFrom === "argument"
      ? `\`dir\` is ${dir}`
      : resolvedFrom === "client-root"
        ? `the client says it is working in ${dir}`
        : `this client did not say which folder it is working in, and the server was started in ${dir}`;
  throw new ScaffoldError(
    `No project folder to write to: ${how}, which is not somewhere a project should be created. ` +
      `Ask the user which folder they want the project in — a new one is fine — and pass it as \`dir\`.`
  );
}

export function scaffold(opts: ScaffoldOptions): ScaffoldResult {
  const { dir, resolvedFrom } = resolveTarget(opts.dir, opts.roots);
  const name = opts.name?.trim() || path.basename(dir);

  // The version is read from package.json at call time, never compiled in: the
  // marker has to say what the user actually installed, or the first absorb
  // pass would re-read releases this project was scaffolded on.
  const files: Array<[string, string]> = [["AGENTS.md", AGENTS_MD(name, packageVersion())]];
  for (const rel of pointerFiles(opts.client)) files.push([rel, pointerContent(rel)]);
  files.push([path.join("renders", ".gitkeep"), ""]);

  const projectConfig = opts.withMcpConfig ? mcpConfigFor(opts.client) : undefined;
  if (projectConfig) files.push([projectConfig.rel, projectConfig.json]);

  // Never clobber existing work: a repeated or half-finished init must be
  // harmless, and this tool can be called by an agent that does not know what
  // is already there.
  const existing = files.map(([rel]) => rel).filter((rel) => fs.existsSync(path.join(dir, rel)));
  if (existing.length > 0) {
    throw new ScaffoldError(
      `${dir} already has ${existing.join(", ")}. Nothing was written. ` +
        `This folder is already set up — or pick a different one.`
    );
  }

  for (const [rel, content] of files) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }

  const hint = opts.withMcpConfig && !projectConfig ? globalConfigHint(opts.client) : undefined;

  const nextSteps = [
    "Open After Effects and open (or save) the project you want to work on.",
    "Ask to set up After Effects if the tools cannot reach it yet — that installs the panel, once per machine.",
    "Ask for a style guide, pointing at a comp that already looks the way you want. It is saved next to the .aep.",
  ];
  if (hint) nextSteps.unshift(`Add the After Effects server to ${hint.path}, then restart the app.`);

  return {
    dir,
    name,
    client: opts.client,
    written: files.map(([rel]) => rel),
    resolvedFrom,
    mcpConfigHint: hint,
    nextSteps,
  };
}
