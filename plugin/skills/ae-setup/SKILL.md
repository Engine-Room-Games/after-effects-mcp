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

## A timeout is not a disconnection

Before you start any repair, check which failure you actually have. "The panel did not answer within N seconds" and "cannot reach the panel" are opposite diagnoses:

- **Did not answer** — something is listening; it is just too busy to reply. After Effects is single-threaded, so a long script or a modal dialog waiting for a click blocks it completely. Nothing is broken and nothing needs installing.
- **Cannot reach** — nothing is listening. That is the case the repair path below is for.

On a timeout, `check_setup` says so itself: `bridgeReachable` reports that the port accepted the connection but did not answer in time, and `nextSteps` tells you to wait. Follow it. Re-running `setup_panel` or restarting After Effects here costs the user their work-in-progress for nothing, and both are the wrong move. Poll `check_setup` for about a minute; it usually clears on its own.

Two things to ask about while waiting: whether a dialog is sitting behind another window in After Effects, and — on macOS — whether they have switched to another desktop. Calls have been reported to stall while the user is on a different Space and to complete as soon as they come back.

## Install before they open After Effects, if you still can

The panel loads at launch and only at launch. So the order matters, and it is
the opposite of what people assume:

- **After Effects is closed** — install now. When they open it, the panel is
  simply there. No restart, nothing to ask for. This is the good path, and on a
  first-time setup you can usually get it.
- **After Effects is open** — install, then they have to quit and reopen it.
  Unavoidable, but worth avoiding: if they have not opened AE yet in this
  conversation, do the install *first* and tell them to open it after.

`check_setup` reports `afterEffectsRunning`, so you always know which case you
are in before you say anything.

## The repair path

1. **`check_setup`** — find out what is actually wrong.
2. **`setup_panel`** — if the panel is missing or out of date. Tell the user what it will do *before* you call it: it copies the panel into their Adobe extensions folder and switches on the Adobe preference that permits unsigned panels. Both changes are user-level and reversible.
3. **Get the panel loaded.** If AE was closed, ask them to open it. If it was already open, ask them to quit and reopen it. You cannot do either for them.
4. **`check_setup`** again to confirm.

## What the individual failures mean

| Check | Meaning when it fails |
|---|---|
| `platform` | Not macOS or Windows. After Effects only runs on those two, so there is nothing to fix. |
| `panelAssetsPresent` | The server package is incomplete — it needs reinstalling. |
| `cepDebugMode` | Adobe refuses to load unsigned panels until this preference is on. `setup_panel` sets it. |
| `panelInstalled` | The panel is not in the Adobe extensions folder yet. `setup_panel` installs it. |
| `panelUpToDate` | The files on disk are older than this server. Run `setup_panel`. |
| `panelRunningCurrent` | AE is *running* an older panel than these tools ship. This is the one that predicts whether calls will actually work — `panelUpToDate` can pass while this fails, for the whole window between installing an update and restarting AE. |
| `afterEffectsRunning` | AE is closed. If the panel also needs installing, install it now and then ask them to open AE — that saves a restart. |
| `bridgeReachable` | Everything is installed but the panel isn't answering. Read the detail: if the port **timed out**, After Effects is busy and you should wait, not restart. If nothing is listening at all, restarting AE almost always fixes it. |

## The reboot case

`cepDebugMode` is an Adobe preference that, on some macOS builds, only takes effect after a **restart of the Mac** — not just of After Effects. If `setup_panel` reports `rebootRecommended: true` and restarting AE alone did not fix it, ask the user to reboot once. This is a one-time cost, never needed again.

## When a tool says the panel is out of date

You may get an error saying the panel is older than these tools, or that it does
not recognise an op. That is a version mismatch, not a broken tool, and the
message tells you which of the two fixes applies:

- **"updated on disk … still running the previous version"** — `setup_panel` has
  already done its part. Only a restart of After Effects will help; running it
  again will not.
- **anything else** — run `setup_panel`, then get AE restarted.

Either way, do not retry the failed call until the user confirms AE has
restarted. Say it as a version mismatch in plain language, not as a failure:
their tools moved ahead of the panel, and it takes a restart to catch up.

## If it still will not connect

Ask the user to open **Window > Extensions > AE MCP Bridge** inside After Effects. That panel shows its own status and a log, and will say whether it started, which port it took, or what error it hit. Have them read it back to you.

A common cause is a stale install: the panel loaded an older script bundle than the server expects. `check_setup`'s `panelUpToDate` catches that — the fix is `setup_panel` followed by an AE restart.
