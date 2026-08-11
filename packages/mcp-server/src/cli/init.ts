import fs from "node:fs";
import path from "node:path";

/**
 * `npx @engine-room/after-effects-mcp init <dir>` — scaffold a working folder
 * for one video, series or client.
 *
 * The point of the scaffold is the separation it encodes: the plugin ships
 * knowledge about *the tool* and is upgraded with it, while everything here is
 * knowledge about *this user's work* and is theirs to edit. Upgrading one never
 * overwrites the other.
 */

const HOUSE_STYLE = `---
name: house-style
description: The visual and motion style for this project — palette, type, timing and layout rules. Load whenever building or editing anything in After Effects for this project.
---

# House style

<!--
  This file is yours. Claude reads it before building anything in After Effects,
  so whatever you write here becomes the default look of your work.

  Replace the placeholders below with your own values. Be specific and concrete:
  "dark navy #131521 at 92% opacity" is usable, "modern and clean" is not. If a
  number matters — a corner radius, a stroke width, a hold duration — write the
  number down.

  The fastest way to fill this in: build one piece the way you like it, then ask
  Claude "read this comp and write it up in my house-style skill".
-->

## Palette

| Role | Colour | Notes |
|---|---|---|
| Background | \`#000000\` | |
| Primary text | \`#FFFFFF\` | |
| Accent | \`#3DC46E\` | Used for emphasis and positive values |
| Warning / negative | \`#E03333\` | |

## Type

- **Headings:** _font name_, weight, size range
- **Body:** _font name_, weight, size range
- **Tracking / leading:** _your defaults_
- Text is left-aligned unless stated otherwise.

## Motion

- **Standard in:** scale 0 → 108 → 100 with easy ease, over ~0.4s
- **Standard out:** scale → 0 over ~0.3s
- **Easing:** easy ease on everything; no linear motion unless mechanical
- **Idle life:** subtle \`wiggle()\` on position so nothing sits perfectly still

## Layout

- Comp size and frame rate: _e.g. 1920×1080 at 30fps_
- Safe margins: _e.g. 120px from every edge_
- Where elements sit by default: _e.g. lower third, left-aligned_

## Rules

- _Anything that should always or never happen. E.g. "never put text directly on
  footage — always on a rounded chip", "keep total runtime under 8 seconds"._
`;

/**
 * Condensed twin of `plugin/commands/report-ae-issue.md`, which is the canonical
 * version. Users who install the plugin get that one; users who only ran `init`
 * get this. They do not have to match word for word — both have to work on their
 * own — but a change to the reporting flow belongs in both.
 */
const REPORT_COMMAND = `---
description: Send a problem you hit with the After Effects tools to the people who maintain them
argument-hint: "[what went wrong, in your own words]"
---

# Report a problem with the After Effects tools

Assume the person you are helping is a motion designer, not a developer, and may
never have used GitHub. Do the technical part for them.

1. **Find what to report.** Call \`list_known_issues\` with \`status: "unreported"\`.
   It returns what earlier sessions wrote down, plus \`repo\`, \`newIssueUrl\`,
   \`serverVersion\` and \`platform\`. List the entries in plain sentences — not raw
   titles — and ask which to send. If there is nothing recorded but \`$ARGUMENTS\`
   describes a problem, ask what they were doing and what happened, then
   \`log_issue\` it first. If there is nothing at all, say so and stop.

2. **Draft it short.** Title: one concrete line. Body: **What happens** (the
   failing call and exact error), **Why** if known, **Workaround**, and
   **Environment** (\`after-effects-mcp <serverVersion> · <platform> · After
   Effects 2026\`). Leave out their own work — comp names, file paths, client
   names, anything about the video.

3. **Show it and ask.** This posts publicly, so get a real yes.

4. **Send it.** \`gh issue create --repo <repo> --title "..." --body "..."\`. If
   \`gh\` is missing or not logged in, do not install it — build a prefilled link
   instead by URL-encoding the title and body onto \`<newIssueUrl>\` as
   \`?title=…&body=…\`, and tell them to open it and press the green button.

5. **Close the loop.** On success call \`mark_issue_reported\` with the entry id
   and URL, then give them the link. If they decline, leave the entry unreported.
`;

const CLAUDE_MD = `# {{NAME}}

After Effects project folder. The tools drive After Effects directly from here.

## How to work in this folder

1. Open After Effects with the project you want to work on.
2. Describe what you want in plain language — "build a lower third that says
   Chapter One and slides in from the left".
3. The current state of the comp is read, the change is made, and you see it.

## Style

The look of everything built here is defined in
\`.claude/skills/house-style/SKILL.md\`. Edit that file to change the defaults —
palette, type, timing, layout. It is read automatically.

## When a tool misbehaves

Check \`list_known_issues\` before guessing — an earlier session may already have
solved it. When you work out a fix for something that cost real time and was the
tool's fault rather than yours, record it with \`log_issue\` so the next session
does not pay for it again, and offer at the end of your reply to pass it on.
\`/report-ae-issue\` sends it to the maintainers.

## Conventions for this project

<!-- Anything specific to this project rather than to your general style:
     naming conventions for comps and layers, delivery specs, the client's
     requirements, what lives in which comp. -->

- Renders go in \`renders/\`.
`;

const MCP_JSON = `{
  "mcpServers": {
    "after-effects": {
      "command": "npx",
      "args": ["-y", "@engine-room/after-effects-mcp"]
    }
  }
}
`;

export interface InitOptions {
  dir: string;
  withMcp: boolean;
}

const KNOWN_FLAGS = ["--no-mcp", "--with-mcp"];

export function parseInitArgs(argv: string[]): InitOptions | { error: string } {
  const positional = argv.filter((a) => !a.startsWith("-"));
  // The config is written by default; --no-mcp is for clients that already
  // provide the server some other way.
  const withMcp = !argv.includes("--no-mcp");
  const unknown = argv.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.includes(a));
  if (unknown.length > 0) return { error: `Unknown option: ${unknown[0]}` };
  if (positional.length === 0) return { error: "Missing target directory." };
  if (positional.length > 1) return { error: `Expected one directory, got ${positional.length}.` };
  return { dir: positional[0]!, withMcp };
}

export function runInit(argv: string[]): number {
  const parsed = parseInitArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\nUsage: npx @engine-room/after-effects-mcp init <directory> [--no-mcp]\n`);
    return 1;
  }

  const target = path.resolve(parsed.dir);
  const name = path.basename(target);

  const files: Array<[string, string]> = [
    ["CLAUDE.md", CLAUDE_MD.replace("{{NAME}}", name)],
    [path.join(".claude", "skills", "house-style", "SKILL.md"), HOUSE_STYLE],
    [path.join(".claude", "commands", "report-ae-issue.md"), REPORT_COMMAND],
    [path.join("renders", ".gitkeep"), ""],
  ];
  if (parsed.withMcp) files.push([".mcp.json", MCP_JSON]);

  // Never clobber existing work: an aborted or repeated init must be harmless.
  const existing = files.map(([rel]) => rel).filter((rel) => fs.existsSync(path.join(target, rel)));
  if (existing.length > 0) {
    process.stderr.write(
      `Refusing to overwrite existing files in ${target}:\n` +
        existing.map((f) => `  ${f}\n`).join("") +
        `\nDelete them first, or choose a different directory.\n`
    );
    return 1;
  }

  for (const [rel, content] of files) {
    const full = path.join(target, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }

  // Safe to write to stdout: this path never starts the stdio MCP server.
  const out = [
    `Created ${target}`,
    ``,
    `  CLAUDE.md                                what this project is`,
    `  .claude/skills/house-style/SKILL.md      your look — edit this first`,
    `  .claude/commands/report-ae-issue.md      /report-ae-issue — tell the maintainers something broke`,
    `  renders/                                 exports land here`,
    ...(parsed.withMcp ? [`  .mcp.json                                connects your client to After Effects`] : []),
    ``,
    `Next:`,
    `  1. Open the folder in your MCP client:  cd ${parsed.dir}`,
    `  2. Open After Effects, then ask it to set up After Effects.`,
    `  3. Fill in .claude/skills/house-style/SKILL.md with your palette, type and timing.`,
    ...(parsed.withMcp
      ? []
      : [
          ``,
          `This folder has no .mcp.json, so your client must already provide the`,
          `After Effects tools some other way.`,
        ]),
    ``,
  ].join("\n");
  process.stdout.write(out);
  return 0;
}
