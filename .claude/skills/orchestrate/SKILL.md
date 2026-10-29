---
name: orchestrate
description: Run work in this repo as an orchestrator — keep your own context slim and hand research, implementation, adversarial review and live After Effects checks to Opus sub-agents, then merge what is finished, tested and reviewed. Load when asked to orchestrate, use sub-agents, fan out, work through several issues, or run a fix sweep. For developing this repo, not for driving After Effects.
---

# Orchestrating work in after-effects-mcp

The maintainer's rule, verbatim: *"Orchestration means you keep your context
window as slim as possible and manage sub-agents (Opus) for everything. They
research, implement, review (adversary review). When a feature is finished,
tested and reviewed, you are responsible for merges."*

## Your role

- **Do not read big files or diffs yourself.** No `gh pr diff`, no source
  dumps. If you need to know something, an agent finds out and tells you.
- Hold only short reports. End every brief with: *"Report in ≤150 words: what
  changed, PR URL, test result, anything you could not verify."*
- Track state in a short list: issue → branch → PR → review → live check → merged.
- `model: "opus"` for every agent. Launch independent agents in one message so
  they run in parallel.
- **Keep what you depend on.** Agents may be refused writing report files, and
  scratch space gets cleaned. Have agents return findings in their reply, and
  save each findings/verdict file you need yourself in
  `~/.engineroom-ae-mcp-orchestrate/<date>/` — outside the repo, and never in
  agent scratchpads, `$TMPDIR` or worktrees, which get cleaned.
- **Every agent that cleans up deletes only what it created.** Brief it to
  record each file, folder, worktree and project it makes, and delete only
  those — never a folder because it looks like scratch. One cleanup deleted the
  reviewers' findings and a shared worktree.

## 1. Implement — one issue, one branch, one agent

Agent tool, `isolation: "worktree"`, `model: "opus"`. Worktrees are cut from
`main`; say so if the work depends on an unmerged branch. The brief is the only
context the agent gets, so make it self-contained:

- the issue number (`gh issue view N`) and the outcome wanted;
- read `CLAUDE.md`, plus the `docs/*.md` for the subject (the table at the top
  of `CLAUDE.md` says which);
- branch `fix/N-short-name` (or `feat/`, `chore/`) from `origin/main`;
- `npm run build` and `npm test` must pass; add or extend a `tests/unit/` test
  that fails without the fix;
- commit with the attribution trailer from the session's system reminder;
- push and open a PR against `main` whose body says `Closes #N`;
- **never merge**, never release, never edit `CLAUDE.md` or settings;
- list anything that needs live After Effects to confirm.

## 2. Adversarial review — a fresh agent, never the implementer

For a fan-out review of `main` (not one PR), create **one** detached worktree
of `origin/main`, build it once, and point every reviewer at it read-only. Tell
each agent not to modify or delete it; remove it yourself when all are done.

Give a PR reviewer the **PR number only**, not the implementer's report or
reasoning: a reviewer handed a conclusion confirms it. Brief it to read
`CLAUDE.md` and try to break the change, checking at least:

- every new op classified in `OpMutation`; cross-field rules via `crossField()`,
  never `.refine()`; every emitted schema valid draft 2020-12;
- undo groups open and close inside one `evalScript`, only via `__beginUndoGroup`;
- generated files untouched (`plugin/skills/**`, `plugin/commands/**`,
  `src/generated/content.ts`) — guidance edits go to `src/guides/` / `src/prompts/`;
- `packages/jsx/*.jsx` stays ES3 (no `let`/`const`/arrows/templates/`Object.keys`);
- nothing in `mcp-server` writes to stdout (no `console.log`);
- no success reported for work that did not happen; free-form schemas `.strict()`;
- the bundle stays deterministic; the four bridge-failure messages stay distinct;
- the new test actually fails without the fix.

Findings come back with severity (blocker / should-fix / nit) and file:line.
Route blockers and should-fixes to the implementer with `SendMessage` (its
context is intact) or to a fresh fix agent on the same branch. Then a **new**
reviewer re-reviews. Repeat until clean.

Budget several rounds for anything that touches After Effects: in every feature
PR so far, the live run found real bugs after code review approved.

## 3. Live After Effects check — one agent at a time

After Effects is one shared app on the maintainer's machine. **Serialize:** only
one agent touches AE at any moment, and ask before using it while the
maintainer or another session may be mid-project. Brief the agent to:

- **protect the maintainer's AE state first**, before the first launch of the
  run. AE writes prefs on quit, so back up and restore with AE quit — if it is
  running, ask the maintainer before quitting it. Back up, and afterwards
  restore byte-identical: the prefs file holding Open Recent (macOS:
  `~/Library/Preferences/Adobe/After Effects/<ver>/Adobe After Effects <ver>
  Prefs.txt`, section "Most Recently Used (MRU) Files…"; `<ver>` is the
  running AE's, e.g. `26.5`) and that folder's `ModifiedWorkspaces/`; on
  Windows the same names under `%APPDATA%\Adobe\After Effects\<ver>\`. Scratch
  projects otherwise push real entries off Open Recent — it happened on a first
  run. If the maintainer used AE in between, skip the restore and tell him — a
  byte-identical restore would wipe his own pref changes;
- follow the matching recipe in `docs/verification-recipes.md`;
- read "Panel version gating" in `docs/subsystems.md` and
  `docs/fragile-areas-bridge.md` before touching the panel;
- **drive the PR-built server, never this session's `after-effects` tools.**
  `.mcp.json` runs the main checkout's `dist/` — whatever was last built there,
  never the PR — and once the running bundle changes, its gate rightly reports
  "panel out of date": the running bundle no longer matches the hash that
  server holds. Start the PR worktree's own server over stdio. POSTing
  the panel's `/op` directly (header `x-ae-mcp-token`, token in
  `~/.engineroom-ae-mcp/token-<port>`) skips zod validation, `crossField()` and
  the `run_jsx` input rewrite, so it is valid only for a jsx-only change;
- hot-load: back up the installed `bundle.jsx`, run
  `AE_MCP_SYNC_PANEL=1 npm run build` **in the PR worktree** (never the main
  checkout — that rewrites the `dist/` other sessions' `.mcp.json` serves),
  `POST /reload-jsx` with the token header, test, then restore the backup and
  reload again. `/reload-jsx` swaps the running bundle for every session on
  that AE until restored, so keep the window short and tell the maintainer;
- changes under `packages/ae-panel/client/` cannot be hot-loaded. Sequence:
  ask the maintainer → quit AE → back up the whole installed extension folder
  (`install:panel` replaces all of it) → `npm run install:panel` → launch →
  test → quit → restore the folder byte-identical → relaunch. Ask before every
  quit. A restore takes effect only at the next launch;
- report what was observed, not inferred, and what could not be exercised.

Plan a live run before merging any AE-facing change; only the maintainer can
waive it (see §4). After a fix, re-run only the recipes that failed plus one
regression check, not the whole set.

## 4. Merge — yours alone, one at a time

Merge a PR only when all hold:

- `gh pr checks <N>` is green (`--watch` to wait);
- the latest review is clean;
- live verification is done, or the maintainer explicitly waived it.

Then `gh pr merge <N> --merge`, and `git push origin --delete <branch>` —
`--delete-branch` fails when another worktree holds `main`. Merge
sequentially; after each, send the next PR's agent to rebase on `origin/main`,
rebuild, retest and push, then wait for CI again. GitHub closes only the
**first** issue in a `Closes` list — close the rest with `gh issue close N --comment "Fixed in #PR"`.
Releasing is a separate decision (`make release`, see `CLAUDE.md`); do not
release unless asked.

## Reporting to the maintainer

Migs is a designer, not an engineer. Report outcomes in plain language — what
now works, what was checked in After Effects, what still needs him — with PR
links. No stack traces, no file lists, and never hand him an engineering task.
