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

**You do not have to read the journal before you start.** When a call fails,
the error itself ends with `Known from earlier sessions: <scope:id> — <title>`
for anything that matches its tool and its error text — up to three, most
recently seen first, the overflow counted — and names the
`list_known_issues({id})` call that opens the first. The cause and the
workaround are in the entry, not in the index. A match is also a sighting: the
entry's `lastSeen` and `lastVersion` move, so an entry that keeps biting stays
live.

Reach for the listing when you are planning something that has bitten before
(`tool` or `query` narrows it) or when the user asks what is known. It is an
index — id, scope, title, tools, `kind`, `lastSeen`, `lastVersion`, counts —
with the entries naming the tool first and then the most recently seen first,
and a `next` pointer spelling out the call that opens the top one. Archived
entries — unseen for 30 days, a `tool-bug` last seen on an older server than
the one running, or retired with `archive_issue` — are hidden and counted in
`archivedCount`; `includeArchived: true` shows them, and a read by `id` always
works, archived or not, because a failure's pointer can name one (marked
archived, with the reason).

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

Write the entry for someone who has not seen the failure: the call that
produced it, the exact error text, and a workaround concrete enough to apply
directly. **Pass `tools` and the exact `errorText`.** That is what lets the
next failure be answered with your entry, and it is what folds a re-log of the
same error into the existing entry even if you gave it a different title — the
result says `mergedBy: "errorText"` and keeps the existing title. Logging under
an existing title extends that entry too, so if the failure brought you an
entry, extend it rather than writing a twin. Use `kind: "ae-quirk"` for a
permanent After Effects behaviour, so a new release does not archive it as
fixed; the default `tool-bug` is presumed fixed once it was last seen on an
older server than the one running. Every entry records the server version it
was first and last seen on. If the result says `reopened: true`, a problem
that was supposed to be gone is back — tell the user.

**Pick the scope by what the entry is about, not by where you are.** Leave it
at the default `project` for this project's footage, comps or files. Pass
`scope: "user"` when it is about how these tools or After Effects behave — that
is nearly everything worth logging, and it is the difference between the next
project starting out knowing it and re-learning it.

## Retire what is no longer true

An entry has to be able to leave, and most leave on their own: one unseen for
30 days, or a `tool-bug` last seen on an older server than the one running, is
archived without anyone deciding — and comes back the moment a failure matches
it or a `log_issue` lands on it. `archive_issue({id, reason})` is for a
decision: a report already covers the problem (pass its URL as the reason), a
release fixed it, or the lesson has been promoted into the
`extendscript-gotchas` topic or the project's own docs. An archived entry stays
on disk, leaves the index, and is still named by a matching failure — marked
archived, with the reason — so the pointer leads somewhere; only a deliberate
`log_issue` reopens it. A journal that only grows is one nobody reads.

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
the tracker for a report that already covers the problem before drafting one,
archiving the entry when that report is closed and marking it reported when it
is open, and handles the rest.
If they say no, drop it; the note stays and can be offered again another time.

Never claim you have reported something you have not.
