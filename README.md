<div align="center">

<img src="https://raw.githubusercontent.com/Engine-Room-Games/after-effects-mcp/main/demo/engine-room-title.gif" alt="Engine Room — After Effects MCP" width="720">

# After Effects MCP

**Control Adobe After Effects with AI.**

Describe the animation you want — a lower third, a logo reveal, an animated counter — and it gets built in your project: layers, keyframes, easing, effects, expressions and text. All of it editable afterwards, exactly like work you made by hand.

[![npm](https://img.shields.io/npm/v/@engine-room/after-effects-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/@engine-room/after-effects-mcp)
[![CI](https://github.com/Engine-Room-Games/after-effects-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Engine-Room-Games/after-effects-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Engine-Room-Games/after-effects-mcp/blob/main/LICENSE)
[![After Effects 2026](https://img.shields.io/badge/After%20Effects-2026-9999ff?logo=adobeaftereffects&logoColor=white)](https://www.adobe.com/products/aftereffects.html)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![MCP](https://img.shields.io/badge/MCP-server-000000)](https://modelcontextprotocol.io)

Works with **Claude**, **Cursor**, **VS Code**, **Codex**, **Windsurf** and any other MCP client.

</div>

---

## ✨ What it builds

Six scenes from one quarterly-report sequence, each in a different visual style. Every layer, keyframe and effect below was built through these tools.

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

---

## 🚀 Getting started

Three steps, and you only do the first two once.

**You'll need:** After Effects 2026, on macOS or Windows.

### 1️⃣ Install

Pick the row that matches how you work, and open it for the steps.

<details>
<summary><b>🖥️ Claude Desktop</b> — one click, nothing else to install</summary>

<br>

Download [the latest `.mcpb` file](https://github.com/Engine-Room-Games/after-effects-mcp/releases/latest) and open it. Claude Desktop takes it from there — no terminal, nothing else to install.

</details>

<details>
<summary><b>⚡ Cursor, VS Code, Claude Code, Codex, Windsurf</b> — if you have Node 22+</summary>

<br>

Add this to your client's MCP configuration:

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

VS Code uses a slightly different shape — put this in `.vscode/mcp.json`:

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

Restart your client afterwards.

</details>

<details>
<summary><b>📦 Any client, without Node</b> — a standalone download</summary>

<br>

Download the build for your machine from [the latest release](https://github.com/Engine-Room-Games/after-effects-mcp/releases/latest), unzip it anywhere, and point your client at the executable inside:

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "/Users/you/Applications/after-effects-mcp/after-effects-mcp"
    }
  }
}
```

Keep the unzipped folder together — the After Effects panel lives next to the executable.

The macOS builds are signed and notarized. The Windows build is unsigned, so SmartScreen may warn the first time you run it.

</details>

<details>
<summary><b>🔌 Claude Code plugin</b> — adds skills and slash commands</summary>

<br>

This repository doubles as a plugin marketplace:

```
/plugin marketplace add Engine-Room-Games/after-effects-mcp
/plugin install after-effects@engine-room
```

</details>

### 2️⃣ Set up After Effects

**Quit After Effects if it's open**, then ask your assistant:

> Set up After Effects.

It installs a small panel into After Effects, which is how the tools talk to it. Open After Effects when it's finished and you're ready to go. 🎉

<sub>Prefer to leave After Effects open? That works too — you'll just be asked to restart it at the end.</sub>

### 3️⃣ Start animating

Open the project you want to work on, then say what you want:

> Build a lower third that says Chapter One, sliding in from the left.

Your assistant reads the current state of your comp, makes the change, and can screenshot the result to check its own work. Everything it builds is ordinary, editable After Effects work — keyframes you can drag, effects you can dial in.

Two commands worth knowing, in any client that supports MCP prompts:

| Command | What it does |
|---|---|
| `/init-after-effects` | 🧭 Walks you through setup and offers to capture your style |
| `/create-style-guide` | 🎨 Teaches it what your work should look like |

---

## 🎨 Your house style

Ask for a style guide and point at a comp you already like. Your colours, fonts, sizes and timing get read off it and saved as `house-style.md` **next to your After Effects project** — and everything built afterwards follows it.

It sits beside the `.aep`, so it travels with the project and works in every client. It's plain markdown, so you can edit it in any text editor.

> ⚠️ Your project needs to have been saved at least once, or there's no folder to put it in.

<details>
<summary><b>What goes in it, and project folders</b></summary>

<br>

A style guide that works is specific: `#131521 at 92% opacity`, not "dark and clean". The most useful lines are the prohibitions — "never put text directly on footage", "keep total runtime under 8 seconds". Ask for a style guide and you'll be walked through it.

Separately, "set up a project folder for me" creates a folder for one video, series or client, with a brief your assistant reads and a `renders/` directory. It writes whichever rules file your client actually reads — `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, and so on. From a terminal, the same thing is:

```bash
npx @engine-room/after-effects-mcp init my-video
```

Updating the tools never touches either file.

</details>

---

## 🔄 Updating

Two pieces update separately, and **the After Effects panel does not update itself**.

1. **The tools** — reinstall the `.mcpb`, download the new standalone build, or just restart your client if you're on `npx`.
2. **The panel** — quit After Effects, then say:

   > Update the After Effects panel.

Reopen After Effects and it's running the new version.

If you forget the second step, nothing breaks silently: the next thing you ask for stops with a plain explanation, and your assistant walks you through it.

---

<details>
<summary><b>🧰 All 74 tools</b></summary>

<br>

| Group | Tools |
|---|---|
| Comps (10) | `list_comps`, `get_comp`, `get_comp_tree`, `create_comp`, `set_comp`, `delete_comp`, `set_active_comp`, `duplicate_comp`, `snapshot_comp`, `diff_comp` |
| Layers (15) | `list_layers`, `get_layer_full`, `create_{text,shape,solid,null,adjustment,precomp,camera,light}_layer`, `duplicate_layer`, `delete_layer`, `set_layer`, `parent_layer`, `reorder_layer` |
| Transforms (1) | `set_transform` — position, scale, rotation, anchor, opacity; 2D and 3D; optionally keyframed |
| Keyframes (6) | `add_keyframe`, `remove_keyframe`, `get_keyframes`, `set_interpolation`, `set_temporal_ease`, `set_spatial_tangents` |
| Expressions (4) | `get_expression`, `set_expression`, `toggle_expression`, `clear_expression` |
| Effects (6) | `list_effects`, `add_effect`, `remove_effect`, `set_effect_param`, `set_effect_enabled`, `list_available_effects` |
| Text (2) | `set_text`, `add_text_animator` |
| Shapes (3) | `set_shape_path`, `add_shape_content`, `set_shape_property` |
| Masks (3) | `add_mask`, `set_mask`, `remove_mask` |
| Markers (2) | `add_marker`, `remove_marker` |
| Vision (2) | `screenshot_frame`, `screenshot_layer` |
| Batch (1) | `run_batch` |
| Footage (2) | `import_footage`, `create_footage_layer` |
| Audio (1) | `place_audio_cues` — a whole cue list placed as one undo step |
| Motion Graphics (1) | `export_mogrt` — export a comp as a `.mogrt` template for Premiere |
| Explore (2) | `get_project_summary`, `find_layers` |
| Raw (1) | `run_jsx` |
| House style (2) | `get_house_style`, `set_house_style` |
| Jobs (3) | `await_job`, `get_job`, `cancel_job` |
| Setup (3) | `check_setup`, `setup_panel`, `init_project` |
| Guidance (1) | `ae_guide` |
| Issues (3) | `list_known_issues`, `log_issue`, `mark_issue_reported` |

A few behave differently from the rest:

- **`get_layer_full`** returns a layer's transforms with their keyframes and expressions, every effect with every parameter, masks, markers and visible bounds — in one call.
- **`run_batch`** runs many operations in a single pass. Up to 500 of them that is one undo step; past that it runs in the background, streams progress, and lands as one undo step per chunk — After Effects will not keep a single undo group across a long job, so the result tells the assistant exactly how many steps the work took. Ask for a single undo step at any size with `singleUndo`, at the cost of freezing After Effects until it finishes.
- **`screenshot_frame`** and **`screenshot_layer`** are for occasional checks, not for reviewing motion frame by frame. To judge movement, `screenshot_frame` takes several times at once and returns them as one labelled contact sheet — one image instead of several. On large comps it renders at reduced resolution unless you ask otherwise.
- **`import_footage`** checks what After Effects actually produced. An SVG whose `viewBox` asks for one shape and imports at another is a known After Effects bug that renders as nothing at all, with no error — so the import is refused and explained rather than left to fail silently later.
- **`export_mogrt`** writes a Motion Graphics template for Premiere. It suppresses the modal dialogs that would otherwise sit there waiting for a click, and can set the thumbnail from any frame you choose, rather than the first one — which is usually black if the comp fades up.
- **`snapshot_comp`** and **`diff_comp`** answer "what did that change actually do" without reading the whole comp back — the assistant fingerprints it before the change and asks afterwards what moved.
- **`run_jsx`** runs arbitrary ExtendScript for anything the other tools don't cover. Long scripts can be run from a file so they never fill up the conversation.
- **`ae_guide`** is how the assistant reads its own working guidance — the same text this server publishes as MCP resources and ships to Claude Code as skills.

</details>

<details>
<summary><b>🩺 When something goes wrong</b></summary>

<br>

Start here: **ask your assistant to check the After Effects setup.** It reports which part is broken and what to do about it.

| Symptom | Cause and fix |
|---|---|
| "Cannot reach the After Effects panel" | After Effects isn't running, or the panel isn't installed. Ask it to set up After Effects; if AE was closed, just open it afterwards. |
| "The panel did not answer within 120 seconds" | Not the same thing. After Effects is busy — usually a long script, or a dialog waiting for a click behind another window. Wait a minute and check again before restarting anything; it normally comes back on its own. |
| "The After Effects panel is out of date" | The tools were updated but the panel wasn't. Ask it to update the panel, then restart AE. |
| "…updated on disk, but After Effects is still running the previous version" | The update landed; AE just hasn't restarted. Quit and reopen it. Updating again won't help. |
| Panel never loads, but setup looks correct | On macOS, reboot once. Some builds cache the Adobe setting until a restart. |
| A panel answers, but the setup check reports none installed | An older install is still serving. Remove it from the CEP extensions folder, reinstall, restart AE. |
| "No project folder to write to" | Your client didn't tell the server where it's working. Say which folder you want. |
| Style guide can't be saved | The After Effects project has never been saved. Save it, then try again. |
| You need the panel's own log | In After Effects: **Window → Extensions → AE MCP Bridge**. |

**If your work legitimately takes longer.** A heavy render or a deliberately long script can pass the limit honestly. Set `AE_MCP_OP_TIMEOUT_MS` in the server's environment to a larger number of milliseconds and it applies to every operation:

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "npx",
      "args": ["-y", "@engine-room/after-effects-mcp"],
      "env": { "AE_MCP_OP_TIMEOUT_MS": "600000" }
    }
  }
}
```

**The issue notebook.** These tools have rough edges. When your assistant hits one and works out a way around it, it writes the problem and the fix into `.ae-mcp/issues/` in your project folder — plain text files you can read or delete. The next session reads that notebook before guessing. The folder keeps itself out of version control.

**Reporting a bug.** If the problem looks like ours rather than yours, you'll be offered the chance to pass it on, or you can start it yourself with `/report-ae-issue`. It writes the report, shows it to you, and only sends it once you say yes. Nothing about your own work — comp names, file paths, clients — goes into it. Sending needs the [GitHub CLI](https://cli.github.com); without it you get a prefilled link to click.

</details>

<details>
<summary><b>💻 Platforms and limitations</b></summary>

<br>

macOS and Windows — the only two platforms After Effects runs on. Two things differ, and both are handled for you:

| | macOS | Windows |
|---|---|---|
| Panel location | `~/Library/Application Support/Adobe/CEP/extensions` | `%APPDATA%\Adobe\CEP\extensions` |
| Unsigned-panel setting | `defaults` preference | `HKCU\Software\Adobe\CSXS.*` registry value |

macOS is the more exercised of the two; [issue reports](https://github.com/Engine-Room-Games/after-effects-mcp/issues) are welcome.

**Signing.** The macOS binaries in each release are signed and notarized by Engine Room, so they run without warnings. The Windows binary is unsigned — SmartScreen may warn on first run — because that needs a separate certificate. If you fork this project and build your own binaries, they'll be unsigned and Gatekeeper will refuse to launch them until you sign with your own Developer ID. The `npx` path has no such constraint.

**Limitations.**

- The After Effects panel is unsigned, so loading it requires Adobe's `PlayerDebugMode`, which the setup step enables. This is Adobe's documented path for unsigned extensions.
- `saveFrameToPng` is community-known rather than officially documented. It works, but alpha edges can be imperfect on some comps.
- A long synchronous loop in `run_jsx` will freeze the After Effects UI. Use `run_batch` for bulk work.
- Not covered: the render queue, footage import and replacement, and application preferences.

</details>

<details>
<summary><b>🛠️ Development</b></summary>

<br>

```bash
git clone https://github.com/Engine-Room-Games/after-effects-mcp.git
cd after-effects-mcp
npm install && npm run build
npm run install:panel
npm run doctor
```

| Command | Purpose |
|---|---|
| `make build` | Compile TypeScript, the guides and the ExtendScript bundle |
| `make jsx` | Rebuild `bundle.jsx` and hot-reload it into a running After Effects |
| `make watch` | TypeScript watch mode |
| `make doctor` | Diagnose the install |
| `make verify` | Build, check version strings and generated files agree, dry-run the package |
| `make artifacts` | Build the `.mcpb` and standalone binaries without releasing |
| `make release` | Bump the patch version, build and sign every artifact, tag, and publish |
| `make release 1.1.0` | The same with an explicit version |

Adding a tool takes three edits: a zod schema in `packages/shared/src/schemas.ts`, a handler in the matching `packages/jsx/*.jsx` module, and a description in `packages/mcp-server/src/tools/descriptions.ts`. Registration is automatic.

Guidance prose is written once in `packages/mcp-server/src/{guides,prompts}/*.md` and generated into the MCP resources, the `ae_guide` tool, the server's `instructions`, and the Claude Code skills and commands. Never edit the generated copies.

Releases are cut from a Mac with a Developer ID certificate; see `scripts/sign-and-notarize.sh` for the environment it expects. See [CLAUDE.md](https://github.com/Engine-Room-Games/after-effects-mcp/blob/main/CLAUDE.md) for the architecture, the ExtendScript conventions, and the known-fragile areas.

</details>

---

<div align="center">
<sub>Built by <a href="https://github.com/Engine-Room-Games">Engine Room</a></sub>
</div>
