---
name: issue-journal
reference: after-effects
description: What to do when a tool fights back — the journal entries a failed call brings you, when a workaround is worth writing down with log_issue and which scope it belongs in, retiring an entry that is no longer true, and how to offer the user the chance to pass a problem on without ever saying "GitHub issue". Load when a call has failed in a way you had to work around.
---

# When something costs you real time

These tools have rough edges, and the same ones catch every session. The
journal exists so that each one is only paid for once — and it comes to you,
rather than you going to it.

## A failure brings its own history

**You do not read the journal before starting work.** When a call fails, the
error names the journal entries that match it — same tool, same error text —
so the moment you have a failure you also have what earlier sessions did about
it. Open one with `list_known_issues({id})`; the cause and the workaround are in
the entry, not in the index. `list_known_issues` with `tool` or `query` is for
the case where the error named nothing and you still suspect this has happened
before.

There are two journals and every entry says which it came from. `project` is
this project's own notes; `user` travels with the person across every project.
Ids are only unique within a journal, so open an entry with the qualified form
the listing's `next` pointer shows you — `list_known_issues({id: "user:…"})`.

## Write it down the moment you work it out

**`log_issue`** records what you learned. Log something when all three are
true: it cost real effort, it was the tool's fault rather than yours, and the
next session would hit it too. A schema that accepts an argument AE then
rejects, an error message that names the wrong thing, a property whose real
name is nothing like its display name. Not your own typos. Not "I forgot the
layer was 3D".

Write the entry for someone who has not seen the failure: the exact error text
(`errorText`, so a later failure can match it), the call that produced it, and a
workaround concrete enough to apply directly. Logging under an existing title
extends that entry rather than adding a near-duplicate — so if the failure
brought you an entry, extend it.

**Pick the scope by what the entry is about, not by where you are.** Leave it
at the default `project` for this project's footage, comps or files. Pass
`scope: "user"` when it is about how these tools or After Effects behave — that
is nearly everything worth logging, and it is the difference between the next
project starting out knowing it and re-learning it.

## Retire what is no longer true

An entry has to be able to leave. When a release fixes the bug an entry works
around, when the workaround has been promoted into the `extendscript-gotchas`
topic or the project's own docs, or when the entry describes a permanent After
Effects fact that belongs in a guide rather than a bug list, `archive_issue`
it: archived entries stay on disk, stop matching failures, and are listed only
with `includeArchived: true`. A journal that only grows is one nobody reads.

## Then offer to pass it on

If `log_issue` comes back with `reported: false`, mention it to the user — but
finish the actual work first, and put it at the very end, after you have told
them what you built. It is a footnote, not the headline.

Say it the way you would to a colleague who does not write code. What you were
trying to do, that it fought back, that you got there anyway, and that you can
send it to the people who maintain the tool so the next person does not lose the
same time. Something like:

> Done — the lower third is in. One thing worth mentioning: getting the ease
> onto that position keyframe took a lot longer than it should have, because the
> tool kept rejecting a value it had just asked for. I found a way around it and
> made a note. Want me to send it to the people who maintain this so they can
> fix it properly?

Do not say "GitHub issue", "file a bug" or "open a ticket" unless they say it
first. If they say yes, use the **report-ae-issue** prompt this server provides
(`/report-ae-issue` where your client exposes prompts as commands) — it checks
the tracker for an existing report before drafting one, and handles the rest.
If they say no, drop it; the note stays and can be offered again another time.

Never claim you have reported something you have not.
