---
description: Send a problem you hit with the After Effects tools to the people who maintain them
argument-hint: "[what went wrong, in your own words]"
allowed-tools: Bash(gh issue create:*), Bash(gh auth status:*), Bash(gh --version)
---

# Report a problem with the After Effects tools

The user wants to tell the maintainers about something that did not work. They are
most likely a motion designer, not a developer: they may never have seen GitHub,
and they should not have to. Do the technical part yourself and only ask them
things they can actually answer.

`$ARGUMENTS` is what they typed, if anything.

## 1. Find out what to report

Call `list_known_issues` with `status: "unreported"`. It returns entries earlier
sessions wrote down, plus `repo`, `newIssueUrl`, `serverVersion` and `platform`.

- **Entries exist** — show them as a short numbered list, one plain sentence each
  ("Text layers ended up in the wrong place when a font was missing"), not the
  raw titles. Ask which to send; offer "all of them" as an option.
- **No entries, but `$ARGUMENTS` describes something** — work from that. Ask what
  they were trying to do and what happened instead, then `log_issue` it so it is
  recorded before you send it.
- **Nothing either way** — say there is nothing recorded to send, and that you
  will write things down as you hit them from now on. Stop there.

## 2. Draft it

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

## 3. Show it and get a yes

Show the finished title and body and ask whether to send it. This posts publicly
to a repository under their name if `gh` is authenticated, so it needs a real
answer, not an assumption. If they want to change the wording, change it.

## 4. Send it

Try `gh` first:

```bash
gh issue create --repo <repo> --title "<title>" --body "<body>"
```

If `gh` is missing or not authenticated, do not try to install or configure it.
Build a prefilled link instead — URL-encode the title and body onto
`<newIssueUrl>` as `?title=…&body=…` — and give it to them with one line of
instruction: open this, it will already be filled in, press the green button. A
GitHub account is needed to press it; if they do not have one, say so plainly and
offer to write the text out for them to send another way.

## 5. Close the loop

On success, call `mark_issue_reported` with the entry `id` and the URL, so no
later session asks them to report the same thing twice. Then tell them where it
went, in one sentence, with the link.

If they decline, leave the entry alone — it stays unreported and can be offered
again another day. Do not mark it.
