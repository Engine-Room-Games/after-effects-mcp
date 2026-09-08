---
name: absorb-release
description: After the After Effects tools update — read what changed since this project last caught up, fix the notes in this folder the update made stale, retire journal entries whose fix has shipped, and record the version so the history is not read again
argument-hint: "[the version this project last absorbed, if its docs do not say]"
allowed-tools: Bash(gh issue view:*), Bash(gh auth status:*), Bash(gh --version)
---

# Absorb a tools update

The After Effects tools have updated, or the user thinks they have. A release
changes what the tools do, and what earlier sessions wrote down about them in
this project — workarounds in AGENTS.md or CLAUDE.md, entries in the issue
journal — does not update itself. This flow reads the delta once, corrects those
notes, and records the version so no later session reads the history again.

`$ARGUMENTS` is the version the project last absorbed, if the user typed one.

## When to run this

At the start of a session, compare two versions:

- **Recorded**: the line `Tools version last absorbed: <version>` in the
  project's docs. `init_project` writes it into AGENTS.md.
- **Running**: the server's own version. `list_known_issues` returns it as
  `serverVersion`, and every `ae_guide({topic: "whats-new"})` answer opens with
  it.

Running newer than recorded, or no recorded line at all, is the cue. Two things
update separately, so there can be two versions to look at: the MCP server (via
npx, the standalone binary, or the Claude Desktop bundle) and, in Claude Code,
the plugin that carries the skills and this command, whose version is in its
`.claude-plugin/plugin.json`. The **server's** version is the one this flow
records, because the server is what answers tool calls and what serves the
whats-new topic. If the plugin is ahead of the server, the skill text may
describe tools the server does not have yet — say so, and suggest updating the
server rather than the notes.

## 1. Find the recorded version

Look for `Tools version last absorbed:` in AGENTS.md, then CLAUDE.md,
`.cursor/rules/`, `.windsurfrules`, `.github/copilot-instructions.md` and any
notes under `.ae-mcp/`. `$ARGUMENTS` overrides whatever is found.

Nothing recorded and nothing typed: ask whether these tools have been used in
this project before. If they have, treat it as never absorbed and read the whole
history — one long read, once. If the project is new, there is nothing to
absorb: go to step 5 and just record the version.

## 2. Read the delta

Call `ae_guide({topic: "whats-new", since: "<recorded>"})`. The first line
names the server version — keep it for step 5. If it says nothing is newer, tell
the user they are up to date, make sure the recorded line exists (step 5), and
stop.

Otherwise, every bullet leads with the rule as it now stands, and a
`supersedes:` line under it quotes the old rule in the words a project's notes
would have used. Those lines are what the next step searches for.

## 3. Correct the project's own notes

For every `supersedes:` line, search the files from step 1 for the old rule —
the phrase, and its key words, because a note will rarely match word for word.
`house-style.md` is about the look, not the tools; leave it alone.

For each hit, show the user the note as it stands, the rule that replaces it,
and the edit you propose: a rewrite when the note still says something true, a
deletion when it only described a bug that is now fixed. A note that mentions a
workaround also teaches the workaround, so prefer deleting to rephrasing. These
are their notes — collect the proposed edits, get one yes, then make them.
Never edit silently.

No hits: say so in one line and move on.

## 4. Retire journal entries whose fix has shipped

Call `list_known_issues({status: "reported"})`. A reported entry carries the URL
of the issue that was filed. If `gh` is installed and signed in (`gh auth
status`), check each one:

```bash
gh issue view <number> --repo <repo> --json state,stateReason
```

- `CLOSED` with `stateReason: COMPLETED` — the fix shipped. Call
  `archive_issue({id, reason: "<url> closed"})`, using the scope-qualified id
  the listing shows (`user:…`, `project:…`).
- `CLOSED` with `NOT_PLANNED` — the behaviour is staying, so the workaround is
  still worth having. Leave it.
- `OPEN` — leave it.

Never archive an entry tagged `kind: "ae-quirk"` on the strength of a closed
issue: those describe After Effects itself, not a tool bug, and a release does
not change them.

Then glance at the unreported entries against the delta: an entry whose symptom
a bullet says is fixed can be archived with the release as the reason — propose
it, do not assume.

If `gh` is missing or not signed in, do not install or configure it. List the
reported entries with their URLs so the user can check them, and leave the
journal as it is.

## 5. Record the version

Write `Tools version last absorbed: <server version>` — the version from the
first line of step 2 — replacing the existing line, or adding it under a
`## Tool updates` heading in AGENTS.md when there was none. No AGENTS.md: use
the file the project reads (CLAUDE.md, or the rules file found in step 1). No
project docs at all — a Claude Desktop session with no folder, say — tell the
user there is nowhere to write it, suggest `init_project` for when they next
want a project folder, and stop.

After this the history is not loaded again for this project until the next
update.

## 6. Say what happened

One short paragraph, in plain language: which version, how many notes were
corrected, which journal entries were retired. No file paths they did not ask
about, and no talk of "supersedes lines" — that is machinery.
