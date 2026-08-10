---
name: ae-setup
description: Diagnose and repair the connection between the AE MCP tools and After Effects — panel not installed, AE not running, Adobe debug preference off, bridge not responding. Load when an After Effects tool reports it cannot reach AE, or when the user is setting this up for the first time.
---

# Getting After Effects connected

The tools talk to a small panel that runs **inside** After Effects. Three things must be true for that to work: the panel is installed, Adobe is willing to load it, and AE is open.

Assume the person you are helping is a motion designer, not a developer. They should never need to open a terminal — you have tools for all of this.

## Always start with check_setup

`check_setup` is read-only and safe to call at any time. It returns a `checks` array and a `nextSteps` list already written in plain language.

**Relay `nextSteps` to the user directly.** Do not paraphrase it into jargon, and do not invent steps it did not mention.

## The repair path

1. **`check_setup`** — find out what is actually wrong.
2. **`setup_panel`** — if the panel is missing or out of date. Tell the user what it will do *before* you call it: it copies the panel into their Adobe extensions folder and switches on the Adobe preference that permits unsigned panels. Both changes are user-level and reversible.
3. **Ask them to quit and reopen After Effects.** The panel only loads at launch. This step is not optional and you cannot do it for them.
4. **`check_setup`** again to confirm.

## What the individual failures mean

| Check | Meaning when it fails |
|---|---|
| `platform` | macOS only for now. Windows needs a different install path and a registry edit. |
| `panelAssetsPresent` | The server package is incomplete — it needs reinstalling. |
| `cepDebugMode` | Adobe refuses to load unsigned panels until this preference is on. `setup_panel` sets it. |
| `panelInstalled` | The panel is not in the Adobe extensions folder yet. `setup_panel` installs it. |
| `panelUpToDate` | The server was upgraded but the installed panel wasn't. Run `setup_panel`, then restart AE. |
| `afterEffectsRunning` | AE is closed. Ask the user to open it. |
| `bridgeReachable` | Everything is installed but the panel isn't answering — almost always fixed by restarting AE. |

## The reboot case

`cepDebugMode` is an Adobe preference that, on some macOS builds, only takes effect after a **restart of the Mac** — not just of After Effects. If `setup_panel` reports `rebootRecommended: true` and restarting AE alone did not fix it, ask the user to reboot once. This is a one-time cost, never needed again.

## If it still will not connect

Ask the user to open **Window > Extensions > AE MCP Bridge** inside After Effects. That panel shows its own status and a log, and will say whether it started, which port it took, or what error it hit. Have them read it back to you.

A common cause is a stale install: the panel loaded an older script bundle than the server expects. `check_setup`'s `panelUpToDate` catches that — the fix is `setup_panel` followed by an AE restart.
