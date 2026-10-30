<div align="center">

<img src="https://raw.githubusercontent.com/Engine-Room-Games/after-effects-mcp/main/demo/engine-room-title.gif" alt="Engine Room — After Effects MCP" width="720">

# After Effects MCP

**Control Adobe After Effects with AI.**

Describe the animation you want and it gets built in your project — layers, keyframes, easing, effects, expressions and text. All of it editable afterwards, exactly like work you made by hand.

[![npm](https://img.shields.io/npm/v/@engine-room/after-effects-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/@engine-room/after-effects-mcp)
[![CI](https://github.com/Engine-Room-Games/after-effects-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Engine-Room-Games/after-effects-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Engine-Room-Games/after-effects-mcp/blob/main/LICENSE)
[![After Effects 2026 tested](https://img.shields.io/badge/After%20Effects-tested%20on%202026-9999ff?logo=adobeaftereffects&logoColor=white)](https://www.adobe.com/products/aftereffects.html)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/migus88)

</div>

## What you can do with it

Talk to your AI assistant the way you'd brief a colleague:

> Build a lower third that says *Chapter One*, sliding in from the left.

> Make the logo pop in with a little overshoot, then hold for two seconds.

> Every layer in this comp should ease in 4 frames later than the one above it.

> Render the main comp into the renders folder.

It reads your comp before it changes anything, makes the change as ordinary After Effects work — keyframes you can drag, effects you can dial in — and can take a screenshot to check its own result. It can also learn your house style, export Motion Graphics templates for Premiere, place sound cues, and render in the background.

Six scenes from one sequence, each in a different style — every layer, keyframe and effect built through these tools:

<table>
  <tr>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/Engine-Room-Games/after-effects-mcp/main/demo/sc01-title.gif" width="100%" alt="Dark title card: Global Macro Fund, Q3 FY2026 performance review, with a rule that draws in under the heading">
      <br><sub><b>Title card</b> — engine dark</sub>
    </td>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/Engine-Room-Games/after-effects-mcp/main/demo/sc02-kpi-grid.gif" width="100%" alt="Editorial KPI grid: four figures counting up, with a risk-budget bar filling to 68 percent">
      <br><sub><b>KPI grid</b> — editorial</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/Engine-Room-Games/after-effects-mcp/main/demo/sc03-nav-curve.gif" width="100%" alt="Amber CRT terminal: a NAV curve drawing on across twelve months with a typed command line above it">
      <br><sub><b>NAV curve</b> — CRT terminal</sub>
    </td>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/Engine-Room-Games/after-effects-mcp/main/demo/sc04-allocation.gif" width="100%" alt="Brutalist allocation breakdown: a stacked colour bar splitting into six labelled sector cards">
      <br><sub><b>Allocation</b> — brutalist</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/Engine-Room-Games/after-effects-mcp/main/demo/sc05-monthly-pl.gif" width="100%" alt="Aurora glass monthly profit and loss: twelve bars growing from a zero line over a soft gradient background">
      <br><sub><b>Monthly P&amp;L</b> — aurora glass</sub>
    </td>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/Engine-Room-Games/after-effects-mcp/main/demo/sc06-outro.gif" width="100%" alt="Minimal print outro on off-white: a single large net return figure resolving into place">
      <br><sub><b>Outro</b> — minimal print</sub>
    </td>
  </tr>
</table>

## What you need

- **After Effects on macOS or Windows.** Tested on After Effects 2026. The panel accepts 2022 or later, but older versions haven't been tested yet.
- **An AI app that runs tools on your own computer.** The tools talk to After Effects directly on your machine, so they work in any app that can start an MCP server locally: **Claude Desktop, Claude Code, Cursor, VS Code, Codex, Windsurf** and the like.

**Claude in a web browser (claude.ai) and ChatGPT — on the web or in its app — can't use them.** Those connect only to tools hosted on the internet, which have no way to reach the After Effects on your computer.

## Getting started

Three steps, and you only do the first two once.

### 1. Install the tools

Pick the one that matches your app.

**Claude Desktop** — the easy one. Download the `.mcpb` file from [the latest release](https://github.com/Engine-Room-Games/after-effects-mcp/releases/latest) and open it. Claude Desktop does the rest; there's nothing else to install.

<details>
<summary><b>Claude Code</b></summary>

<br>

Either install the plugin, which also adds skills and slash commands:

```
/plugin marketplace add Engine-Room-Games/after-effects-mcp
/plugin install after-effects@engine-room
```

or add just the server (needs Node 22 or later):

```bash
claude mcp add after-effects -- npx -y @engine-room/after-effects-mcp
```

</details>

<details>
<summary><b>Cursor, Windsurf and other apps</b> (needs Node 22 or later)</summary>

<br>

Add this to your app's MCP configuration, then restart the app:

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "npx",
      "args": ["-y", "@engine-room/after-effects-mcp"]
    }
  }
}
```

</details>

<details>
<summary><b>VS Code</b> (needs Node 22 or later)</summary>

<br>

Put this in `.vscode/mcp.json`, then restart VS Code:

```json
{
  "servers": {
    "after-effects": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@engine-room/after-effects-mcp"]
    }
  }
}
```

</details>

<details>
<summary><b>Codex</b> (needs Node 22 or later)</summary>

<br>

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.after-effects]
command = "npx"
args = ["-y", "@engine-room/after-effects-mcp"]
```

</details>

<details>
<summary><b>Any app, without Node</b> — a standalone download</summary>

<br>

From [the latest release](https://github.com/Engine-Room-Games/after-effects-mcp/releases/latest), download the zip for your machine — `macos-arm64` (Apple silicon), `macos-x64` (Intel Mac) or `windows-x64` — unzip it anywhere, and point your app at the executable inside:

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "/Users/you/Applications/after-effects-mcp/after-effects-mcp"
    }
  }
}
```

On Windows the executable is `after-effects-mcp.exe`. Keep the unzipped folder together — the After Effects panel lives next to the executable. The macOS builds are signed and notarized; the Windows build is unsigned, so SmartScreen may warn the first time you run it.

</details>

### 2. Set up After Effects

**Quit After Effects if it's open**, then ask your assistant:

> Set up After Effects.

It installs a small panel into After Effects, which is how the tools talk to it. When it's done, open After Effects and you're ready. (Prefer to leave After Effects open? That works too — you'll just be asked to restart it at the end.)

You never have to open the panel yourself; it starts whenever After Effects does.

### 3. Start animating

Open your project and say what you want. Two prompts are worth knowing, in any app that supports MCP prompts:

| Prompt | What it does |
|---|---|
| `/init-after-effects` | Walks you through setup and offers to capture your style |
| `/create-style-guide` | Teaches it what your work should look like |

**One thing to know:** while a dialog box is open in After Effects, nothing else can happen there, so the tools wait and eventually say the panel didn't answer in time. Close the dialog and the work finishes on its own — don't ask for it again, or it gets done twice.

## Your house style

Ask for a style guide and point at a comp you already like. Your colours, fonts, sizes and timing — including how your existing animation eases and staggers — get read off it and saved as `house-style.md` **next to your `.aep`**. Everything built afterwards follows it. It's plain markdown, travels with the project, and works in every app. (The project needs to have been saved once, so there's a folder to put it in.)

The best style guides are specific — `#131521 at 92% opacity`, not "dark and clean" — and the most useful lines are the rules: "never put text directly on footage", "keep total runtime under 8 seconds".

You can also ask it to **set up a project folder** for a video, series or client: a brief your assistant reads, a `renders/` folder, and whichever rules file your app reads (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/` and so on). From a terminal it's `npx @engine-room/after-effects-mcp init my-video`. Updating the tools never touches either file.

## Updating

Two pieces update separately, and **the panel inside After Effects does not update itself**:

1. **The tools** — reinstall the `.mcpb`, download the new standalone build, or just restart your app if you use `npx`. On the Claude Code plugin, run `/plugin marketplace update engine-room` and `/plugin update after-effects@engine-room`, then restart Claude Code.
2. **The panel** — quit After Effects, ask your assistant to *update the After Effects panel*, then reopen After Effects.

Forget the second step and nothing breaks quietly: your next request stops with a plain explanation of what to do.

Afterwards, run `/absorb-release` in your project folder (other apps list it as `absorb-release` in their prompt menu). It tidies up any workarounds earlier sessions wrote into your project notes that the new version makes unnecessary.

## Safety and privacy

- **Only your own computer can talk to After Effects.** The panel listens on `127.0.0.1` — your machine, never your network — and every request must carry a secret key the panel makes fresh each time After Effects starts. Without it, nothing runs.
- **Changes are ordinary undo steps.** Cmd/Ctrl+Z works on what your assistant did, just like on your own edits. In apps that support it, deleting a comp, purging unused footage or reverting a comp asks you first.
- **What your assistant sees goes to the AI model you use** — layer names, text, keyframes, file paths in your project, and screenshots of your comps. If a project is confidential, treat a session with it like pasting it into a chat.

Two optional switches limit what it can do. Both are off unless you turn them on.

| Switch | What it does |
|---|---|
| **Read-only mode** | Your assistant can look at your project — list comps and layers, read keyframes, take screenshots — but every tool that changes something is removed. |
| **Turn off running scripts** | Removes `run_jsx`, the tool that lets your assistant write and run its own After Effects scripts. Everything else still works, rendering included; only jobs no other tool covers (like replacing or relinking footage) become impossible. |

<details>
<summary><b>How to turn them on</b></summary>

<br>

**Claude Desktop:** Settings → Extensions → After Effects, then tick *Read-only mode* or *Turn off running scripts (run_jsx)*.

**Everywhere else:** add an `env` block to the configuration from step 1, then restart your app. Use either line on its own; read-only mode already includes the second.

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "npx",
      "args": ["-y", "@engine-room/after-effects-mcp"],
      "env": {
        "AE_MCP_READ_ONLY": "1",
        "AE_MCP_DISABLE_RUN_JSX": "1"
      }
    }
  }
}
```

A switched-off tool simply isn't there, so your assistant won't try it and will tell you when a request needs it. The switches limit this connection only — they don't lock After Effects, and another assistant connected without them still has every tool.

</details>

## If something goes wrong

**Ask your assistant to check the After Effects setup.** It finds which part is broken and tells you what to do, in plain words.

For specific error messages, longer time limits, the issue notebook and how to report a bug, see [Troubleshooting](https://github.com/Engine-Room-Games/after-effects-mcp/blob/main/docs/troubleshooting.md). Bug reports are welcome in [the issues](https://github.com/Engine-Room-Games/after-effects-mcp/issues) — macOS is the more tested of the two platforms, so Windows reports especially.

## Good to know

- **What's not covered:** replacing or relinking footage (importing it is covered), and After Effects' own preferences.
- **Screenshots are for spot checks.** Alpha edges can be slightly imperfect on some comps.
- **A long loop in a custom script freezes After Effects** until it finishes. Bulk work goes through `run_batch`, which doesn't.
- **The panel is signed**, so After Effects loads it without Adobe's `PlayerDebugMode` setting. Setup still turns that setting on as a fallback; it applies to your whole user account and lets Adobe apps load *any* unsigned panel. A panel installed from a git checkout is unsigned and does need it.
- **Removing it all:** see [Uninstalling](https://github.com/Engine-Room-Games/after-effects-mcp/blob/main/docs/uninstalling.md), which also covers turning the debug setting back off.
- **Every tool, listed:** see [the tools](https://github.com/Engine-Room-Games/after-effects-mcp/blob/main/docs/tools.md) — 89 of them, plus the extras some apps show, like an interactive comp timeline.

## For developers

```bash
git clone https://github.com/Engine-Room-Games/after-effects-mcp.git
cd after-effects-mcp
npm install && npm run build
npm run install:panel
npm run doctor
```

`make help` lists the rest (`make jsx` hot-reloads the ExtendScript bundle into a running After Effects; `make release` builds, signs and publishes). Start with [CLAUDE.md](https://github.com/Engine-Room-Games/after-effects-mcp/blob/main/CLAUDE.md) for the architecture, the conventions and how to add a tool, and [docs/](https://github.com/Engine-Room-Games/after-effects-mcp/tree/main/docs) for the fragile areas and the live verification recipes. Agent guidance is written once in `packages/mcp-server/src/{guides,prompts}/*.md` and generated everywhere else — never edit the generated copies. Forks that build their own binaries get unsigned ones; macOS will refuse them until they're signed with your own Developer ID.

---

<div align="center">
<sub>Built by <a href="https://github.com/Engine-Room-Games">Engine Room</a> · free and open source — if it saves you time, <a href="https://github.com/sponsors/migus88">sponsor its development</a></sub>
</div>
