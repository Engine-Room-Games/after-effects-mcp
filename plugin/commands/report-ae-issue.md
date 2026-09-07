---
name: report-ae-issue
description: Send a problem you hit with the After Effects tools to the people who maintain them
argument-hint: "[what went wrong, in your own words]"
allowed-tools: Bash(gh issue create:*), Bash(gh issue list:*), Bash(gh issue view:*), Bash(gh auth status:*), Bash(gh --version)
---

# Report a problem with the After Effects tools

The user wants to tell the maintainers about something that did not work. They are
most likely a motion designer, not a developer: they may never have seen GitHub,
and they should not have to. Do the technical part yourself and only ask them
things they can actually answer.

`$ARGUMENTS` is what they typed, if anything.

## 1. Find out what to report

Call `list_known_issues` with `status: "unreported"`. It returns a one-line index
of what earlier sessions wrote down, plus `repo`, `newIssueUrl`, `serverVersion`
and `platform`. Once they have chosen, read each chosen entry in full with
`list_known_issues({id})` — the checks and the draft below need the symptom,
error text and workaround, which the index does not carry.

- **Entries exist** — show them as a short numbered list, one plain sentence each
  ("Text layers ended up in the wrong place when a font was missing"), not the
  raw titles. Ask which to send; offer "all of them" as an option. Remember the
  answer: if they said "all of them", step 4 takes one approval for the lot, not
  one per entry.
- **No entries, but `$ARGUMENTS` describes something** — work from that. Ask what
  they were trying to do and what happened instead, then `log_issue` it so it is
  recorded before you send it.
- **Nothing either way** — say there is nothing recorded to send, and that you
  will write things down as you hit them from now on. Stop there.

## 2. Check whether the maintainers already know

Before drafting anything, look at what has already been sent to them — sending
the same problem twice wastes their time and the user's. `repo` came back from
step 1.

```bash
gh issue list --repo <repo> --state all --limit 200 --json number,title,state,url
```

Match each chosen entry against that list by the tool it names and by its error
text: a title that names the same tool and the same failure, or quotes the same
error, is the same problem however it is worded. When a title alone does not
settle it, read the body:

```bash
gh issue view <number> --repo <repo> --json title,body,state,url
```

For every entry that matches something:

- **The match is closed** — it has already been dealt with. Do not send it again.
  Call `archive_issue` with the entry's scope-qualified id and the existing link
  as the reason (`"already closed upstream: <url>"`), so it leaves the list and no
  later session offers it. Tell the user in one plain sentence that this one was
  already fixed or already handled, with the link; if the fix came in a newer
  version than `serverVersion`, say that updating is how to get it.
- **The match is open** — it is known and still being looked at. Do not send a
  second copy. Call `mark_issue_reported` with the entry's scope-qualified id and
  the existing link, and tell the user it is already on the maintainers' list,
  with the link. If they have something to add, it belongs on that one.

Only the entries with no match go on to step 3. If none are left, say so and
stop.

If `gh` is missing or not signed in, skip this step, say so in one line, and
carry on — step 5 has the fallback for sending.

## 3. Draft it

Short. A maintainer should understand the problem in fifteen seconds.

**Title:** one line, concrete. `set_temporal_ease fails on Position with "Value
array does not have 1 elements"` — not `Keyframe bug`.

**Body:** four short sections, a couple of sentences each.

```markdown
**What happens**
<the failing call and the exact error, or the wrong result>

**Why** (if known)
<one line — omit this section entirely if unknown>

**Workaround**
<what got past it>

**Environment**
after-effects-mcp <serverVersion> · <platform> · After Effects 2026
```

Include the failing call and error text verbatim — that is the part that makes it
fixable. Leave out the user's own content: comp and layer names from their
project, file paths, client names, anything about the video they are making. If a
detail like that is load-bearing, replace it with a placeholder.

## 4. Show it and get a yes

Show the finished title and body and ask whether to send it. This posts publicly
to a repository under their name if `gh` is authenticated, so it needs a real
answer, not an assumption. If they want to change the wording, change it.

If they chose "all of them" in step 1, show every draft together, once, and take
one yes for the lot. Do not ask again for each one.

## 5. Send it

Try `gh` first. Write the body to a temporary file and pass the file — a
multi-line markdown body with backticks and quotes does not survive being quoted
on a command line:

```bash
gh issue create --repo <repo> --title "<title>" --body-file <temp-file>
```

One call per draft; remove the temporary file afterwards.

If `gh` is missing or not authenticated, do not try to install or configure it.
Build a prefilled link instead — URL-encode the title and body onto
`<newIssueUrl>` as `?title=…&body=…` — and give it to them with one line of
instruction: open this, it will already be filled in, press the green button. A
GitHub account is needed to press it; if they do not have one, say so plainly and
offer to write the text out for them to send another way.

## 6. Close the loop

On success, call `mark_issue_reported` with the entry `id` and the URL, so no
later session asks them to report the same thing twice. Use the same
scope-qualified id the listing gave you (`user:…`, `project:…`): the two
journals can hold the same slug, reporting one says nothing about the other, and
an unqualified id leaves which one moved to chance. Then tell them where it went,
in one sentence, with the link.

If they decline, leave the entry alone — it stays unreported and can be offered
again another day. Do not mark it.
