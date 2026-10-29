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

Give the reviewer the **PR number only**, not the implementer's report or
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

## 3. Live After Effects check — one agent at a time

After Effects is one shared app on the maintainer's machine. **Serialize:** only
one agent touches AE at any moment, and ask before using it while the
maintainer or another session may be mid-project. Brief the agent to:

- follow the matching recipe in `docs/verification-recipes.md`;
- read "Panel version gating" in `docs/subsystems.md` and
  `docs/fragile-areas-bridge.md` before touching the panel;
- hot-load without breaking other sessions: back up the installed `bundle.jsx`,
  `AE_MCP_SYNC_PANEL=1 npm run build`, `POST /reload-jsx` with the
  `x-ae-mcp-token` header, test through a **fresh** server process (this
  session's own `after-effects` tools run a server whose gate cached the old
  hash and will falsely say "panel out of date"), then restore the backup and
  reload again;
- changes under `packages/ae-panel/client/` cannot be hot-loaded — they need
  `npm run install:panel` with AE quit; ask the maintainer before quitting AE;
- report what was observed, not inferred, and what could not be exercised.

## 4. Merge — yours alone, one at a time

Merge a PR only when all hold:

- `gh pr checks <N>` is green (`--watch` to wait);
- the latest review is clean;
- live verification is done, or the maintainer explicitly waived it.

Then `gh pr merge <N> --merge --delete-branch`. Merge sequentially; after each,
send the next PR's agent to rebase on `origin/main`, rebuild, retest and push,
then wait for CI again. GitHub closes only the **first** issue in a `Closes`
list — close the rest with `gh issue close N --comment "Fixed in #PR"`.
Releasing is a separate decision (`make release`, see `CLAUDE.md`); do not
release unless asked.

## Reporting to the maintainer

Migs is a designer, not an engineer. Report outcomes in plain language — what
now works, what was checked in After Effects, what still needs him — with PR
links. No stack traces, no file lists, and never hand him an engineering task.
