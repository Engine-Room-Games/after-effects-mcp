---
name: ae-setup
description: Diagnose and repair the connection between the AE MCP tools and After Effects — panel not installed, AE not running, Adobe debug preference off, bridge not responding, bridge on the wrong port, CEP refusing the panel's signature. Load when an After Effects tool reports it cannot reach AE, or when the user is setting this up for the first time.
---

# Getting After Effects connected

The tools talk to a small panel that runs **inside** After Effects. Three things must be true for that to work: the panel is installed, Adobe is willing to load it, and AE is open.

Assume the person you are helping is a motion designer, not a developer. They should never need to open a terminal — you have tools for all of this.

## Always start with check_setup

`check_setup` is read-only and safe to call at any time. It returns a `checks` array and a `nextSteps` list already written in plain language.

**Relay `nextSteps` to the user directly.** Do not paraphrase it into jargon, and do not invent steps it did not mention.

## A timeout is not a disconnection

Before you start any repair, work out which of **four** failures you have. They
read alike and their remedies contradict each other:

- **Did not answer in time** — something is listening; it is just too busy to
  reply. After Effects is single-threaded, so a long script or a modal dialog
  waiting for a click blocks it completely. Nothing is broken and nothing needs
  installing. The call **did** reach After Effects and may still be running, so
  do not re-send it.
- **Cannot reach** — nothing is listening on the port the server tried. That
  is the case the repair path below is for — *unless* the next case applies,
  so read the message to the end: it now says which other ports it looked at
  and what it found there.
- **Cannot reach on port X, while `check_setup` reports the panel on port Y**
  — the server's idea of the port went stale, not the panel. The panel is
  running and answering; the server was started from a port file that no
  longer described it. `check_setup` reports this as its own check,
  `portAgreement`, with both numbers. Retry the failed call: the server
  re-checks the port whenever a call is refused and switches to the port that
  answers by itself. If it still fails, reconnect the MCP server (restart the
  client's connection to it, not After Effects). **Never restart After Effects
  for this** — something is listening, and a restart costs the user their work
  in progress for nothing.
- **Waited behind another op for the write queue and was dropped** — the panel
  is fine and this call never left the server, so nothing in the project was
  changed. Writes are serialized so that they land in the order the agent issued
  them and nothing drops into the middle of work the user asked for as one
  thing; something in front is taking a very long time, usually a long
  `run_batch`. Re-sending **is** safe here, once the work in
  front has finished; this is the one of the four where it is. Find out what is
  in front with `get_job` or `await_job` — reads are never queued, so `list_`
  and `get_` calls still answer.

The message itself tells you which one you have; the queue error says in as many
words that nothing was written. Never collapse them into "the bridge is playing
up", because "re-send it", "do not re-send it" and "do not restart it" are three
different answers.

On a timeout, `check_setup` says so itself: `bridgeReachable` reports that the port accepted the connection but did not answer in time, and `nextSteps` tells you to wait. Follow it. Re-running `setup_panel` or restarting After Effects here costs the user their work-in-progress for nothing, and both are the wrong move. Poll `check_setup` for about a minute; it usually clears on its own.

Two things to ask about while waiting: whether a dialog is sitting behind another window in After Effects, and — on macOS — whether they have switched to another desktop. Calls have been reported to stall while the user is on a different Space and to complete as soon as they come back.

A **full** write queue is a fifth message and a different instruction again:
too many calls are already waiting, so stop issuing writes and let it drain. If
you have that much independent work, send it as one `run_batch` — one
ExtendScript pass and one place in the queue, instead of dozens of each.

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
2. **`setup_panel`** — if the panel is missing or out of date. Tell the user what it will do *before* you call it: it copies the panel into their Adobe extensions folder and switches on two Adobe preferences — the one that permits unsigned panels, and CEP's own log (only where it was never set), so that if AE ever refuses to load the panel the reason is recorded. All of it is user-level and reversible. One caution: if `check_setup` showed the install as **self-signed**, `setup_panel` replaces it with an unsigned copy and the signing has to be done again — say so before calling it.
3. **Get the panel loaded.** If AE was closed, ask them to open it. If it was already open, ask them to quit and reopen it. You cannot do either for them.
4. **`check_setup`** again to confirm.

## What the individual failures mean

| Check | Meaning when it fails |
|---|---|
| `platform` | Not macOS or Windows. After Effects only runs on those two, so there is nothing to fix. |
| `panelAssetsPresent` | The server package is incomplete — it needs reinstalling. |
| `cepDebugMode` | Adobe refuses to load unsigned panels until this preference is on. `setup_panel` sets it. |
| `panelInstalled` | The panel is not in the Adobe extensions folder yet. `setup_panel` installs it. When it passes, the detail also says whether the install is **self-signed** — see the last section. |
| `panelUpToDate` | The files on disk are older than this server. Run `setup_panel`. A self-signed install's extra files (`META-INF/`, `mimetype`) do not count as differences. |
| `panelRunningCurrent` | AE is *running* an older panel than these tools ship. This is the one that predicts whether calls will actually work — `panelUpToDate` can pass while this fails, for the whole window between installing an update and restarting AE. |
| `afterEffectsRunning` | AE is closed. If the panel also needs installing, install it now and then ask them to open AE — that saves a restart. |
| `bridgeReachable` | Everything is installed but the panel isn't answering **on any port** — it asks the default port and the port file's port both, and reports whichever answers. Read the detail: if a port **timed out**, After Effects is busy and you should wait, not restart. If nothing is listening anywhere, one restart of AE is reasonable, because the panel loads only at launch; if that has already been tried, read `panelSignature` and `nextSteps` before suggesting a second. |
| `portAgreement` | The panel answers, but on a different port from the one tool calls go to. The server is stale, the panel is fine. Retry the call, or reconnect the MCP server. Never restart After Effects for this. |
| `panelSignature` | CEP's own log says it refused to load the panel because its signature failed verification — even with `cepDebugMode` on. An Adobe CEP 12 bug, seen on Windows. No restart and no reinstall helps; `nextSteps` carries the self-signing fix. When it *passes* on a silent bridge, its `evidence` says whether the log was clean or there was no log to read. |

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

## The port, and why it is not the port file

The panel binds port 7777. On one machine nothing else ever uses it, so if
the port is taken when the panel starts, the holder is a previous copy of the
panel itself — a leftover from a relaunch, or a second panel window. The panel
does not move to another port in that case: it says so in its own status
("waiting — port 7777 is held by another AE MCP panel"), and retries until the
old one exits, then takes over with no restart. If a user reports that status
and it does not clear, the leftover process is still running; quitting After
Effects fully and reopening it clears it.

The panel moves only when something that is *not* an AE MCP panel holds the
port, and it logs which port it chose and why. People who really run two
After Effects instances at once can opt back into moving past their own panel
with a small file the panel reads at launch,
`~/.engineroom-ae-mcp/config.json` (`%USERPROFILE%\.engineroom-ae-mcp\config.json`
on Windows): `{ "port": 7777, "allowPortWalk": true }`. The server is told
which port to use with `AE_MCP_PORT`, and with that set it never looks
elsewhere.

Whatever the panel bound goes in the port file beside that config. The server
reads it once at startup as a hint and no more: the socket is the authority,
and when a call is refused the server asks 7777 and the file's port which one
actually answers.

## The panel is installed, AE is open, and nothing is listening

If every check passes except `bridgeReachable`, After Effects has already been
restarted once since the install, and nothing appears when the user opens
**Window > Extensions > AE MCP Bridge** — no window, no error — then the
likely cause is CEP refusing the panel's signature despite `cepDebugMode`
being on. It is an Adobe CEP 12 bug, seen on Windows with After Effects 2026,
and nothing about the install is wrong. Do not send the user round a third
restart.

`check_setup` reads CEP's own log and reports `panelSignature` when it finds
the refusal. If there is no log to read, `nextSteps` says how to turn CEP
logging on (one command, which it spells out; `setup_panel` sets it on new
installs), after which one relaunch of AE and one more `check_setup` gives
a definite answer.

The fix is to sign the installed panel folder with Adobe's own `ZXPSignCmd`
and unzip the result back over the folder in place. `nextSteps` carries the
exact commands. Two things to tell the user: the signing survives updates to
the server but **not** a reinstall — `setup_panel` puts an unsigned copy back
and warns when it does — and `check_setup` keeps reporting a signed install as
up to date, so the extra files it adds are nothing to worry about.

## If it still will not connect

Ask the user to open **Window > Extensions > AE MCP Bridge** inside After Effects. That panel shows its own status and a log, and will say whether it started, which port it took, whether it is waiting for a port another panel holds, or what error it hit. Have them read it back to you.

A common cause is a stale install: the panel loaded an older script bundle than the server expects. `check_setup`'s `panelUpToDate` catches that — the fix is `setup_panel` followed by an AE restart.
