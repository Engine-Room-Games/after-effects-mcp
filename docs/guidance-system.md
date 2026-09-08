# Guidance, and how it reaches an agent

How the prose that teaches an agent to drive After Effects is written once and
generated into every carrier — the MCP `instructions` field, MCP prompts and
resources, the `ae_guide` tool, and the Claude Code skills. **Edit the markdown
under `packages/mcp-server/src/{guides,prompts}/`, never the outputs.**

Back to [CLAUDE.md](../CLAUDE.md).

## Guidance and how it reaches an agent

Tool descriptions cover one tool each. The knowledge that actually costs people
time is cross-cutting — ids not indexes, read then write then verify, which of
three bridge failures is safe to re-send — and belongs to no single tool. The carriers for it, in
descending order of reach:

| Carrier | Reaches | Cost |
|---|---|---|
| Tool descriptions | every client, always | always resident |
| `instructions` (initialize result) | every client that honours it | always resident — keep it short |
| `ae_guide` tool | every client | on demand |
| MCP resources (`ae://guide/…`) | clients with resource support | on demand |
| Claude Code skills | Claude Code, claude.ai | on demand, whole skill at once |
| Claude Code skill references | Claude Code, claude.ai | on demand, one file at a time |

All of them except the tool descriptions come from
`packages/mcp-server/src/guides/*.md` via `scripts/build-guides.mjs`. **Edit the
markdown, never the outputs.** The same script generates
`packages/mcp-server/src/prompts/*.md` into MCP prompts and Claude Code commands.

Three rules that keep this honest:

- **`instructions` is always resident in every session, so it stays short.** It
  says three things: that the session is live, where the real guidance is, and
  the two or three habits that decide whether the *first* calls do damage before
  an agent has read any of it. Everything else is a tax on every request the user
  ever makes — put it in a guide. It was six numbered items and 1,395 characters
  until 0.4.0, restating what `after-effects.md` already said in full; issue #60
  is what that cost. `tests/unit/guide-references.mjs` and the CI smoke test both
  fail it past 1,500 characters, which is a ceiling and not a target. The topic
  list is substituted into `__TOPICS__` at build time, so every guide added
  lengthens it — about 1,170 characters with twelve topics.
- **`ae_guide` exists because the better carriers are not universal.** Some
  clients drop `instructions`; fewer support resources. Tools are the floor
  every client reaches, so the guidance has to be available as one.
- **Only the skill has a per-session cost, so only the skill splits.** A guide
  with `reference: <parent>` in its frontmatter is still a full `ae_guide` topic
  and a full `ae://guide/…` resource — narrowing that half would be a reach
  regression for every non-Claude client — but on the skill side it generates
  into `plugin/skills/<parent>/references/<name>.md` instead of a skill of its
  own, so Claude Code opens it only when the parent points at it. That pointer is
  load-bearing: the generator refuses to build a reference whose parent does not
  name `references/<name>.md`, because a reference nothing points at is a file
  that is never read and never noticed. Nine ship, all under `after-effects`,
  and `tests/unit/guide-references.mjs` lists every one by name so a reference
  cannot go missing from a carrier unnoticed.

### The core and its references

`after-effects.md` was 36 KB and loaded on every AE task, most of which never
touched half of it (issue #98). It is now the **core** — about 13 KB — and it
holds only what silently produces wrong output on *any* task: ids not indexes,
bounded reads (the bounded form leads; "one `get_layer_full` over several
narrow calls" and "bound every read" are reconciled as *the bound is the
`include` list, not the number of calls*), read/write/verify with a diff,
screenshots as a one-off diagnostic with their cost in tokens, write ordering
and the `run_batch` undo rule in eight lines, and the three bridge failures
with contradicting remedies. Everything else is a reference, opened by subject:

| Reference | Holds |
|---|---|
| `animation` | keyframes and easing through the tools, rigging, expressions (comp time vs layer time lives here) |
| `shapes` | spawn origin, `add_shape_content`, render order, stale node references, compact reads |
| `text` | justification as alignment, tracking, `set_text`, sizing a background from `sourceRect` |
| `assembly` | shots built in local time and placed at offsets, comp markers, retiming without touching contents, the precomp that renders nothing before `startTime` (issue #101) |
| `extendscript-gotchas` | **the `run_jsx` reference**: when to script, timeouts and the ~60-layer practical bound, `scriptPath`/`libraries` as the normal way to build, the helpers in scope, the raw-scripting traps by subject, the result and failure contract |
| `sound` | `place_audio_cues`, what `levelDb` means and why a copied level is meaningless, loops, fades and stretch per cue |
| `mogrt-and-footage` | `export_mogrt` and its preconditions, the SVG viewBox trap, the solids `delete_comp` leaves behind and `purge_unused_footage` |
| `issue-journal` | the journal flow: a failure brings matching entries, `log_issue`, retiring an entry, the offer to pass it on |
| `whats-new` | version deltas (issue #60); the only place history lives |

Three rules hold the split honest:

- **Every fact has one home.** A fact that applies whether you use the tools or
  script raw goes in the subject reference (render order is in `shapes`,
  comp-time-vs-layer-time in `animation`); a fact that only bites when writing
  raw ExtendScript goes in `extendscript-gotchas`, with the subject reference
  carrying a one-line pointer at most. Issue #98 counted seven facts stated in
  both the core and the gotchas, and issue #96 found the always-loaded copy of
  the ease arity stale while the reference was right — which is what a second
  copy does. The ease-arity table is in `extendscript-gotchas.md` and nowhere
  else; `animation.md` points at it.
- **Present tense only, outside `whats-new`.** A rule plus its reason clause,
  and at most a "measured on 26.3" tag where the fear is training data rather
  than project notes. No "was never true", no "broken for three releases", no
  "it does now mean" — an agent that reads the route-around learns the route
  (issue #99). What a tool *used to* do goes in `whats-new` and only there.
- **A reference may point at a sibling by topic name**, never at
  `references/<name>.md` — that path form is the parent's pointer, and the
  generator only checks the parent. `extendscript-gotchas` must stay reachable
  under that name: the `instructions` name it, and users' project notes do.

Where a fact goes, in one line: an agent cannot infer it from the tool list *and*
getting it wrong on the first call costs real work → `instructions`; it silently
produces wrong output on any task → the core; it only matters once a task has
reached a subject → that subject's reference.

### Release history, and reading it once

History has a fourth place to go, and it is the one that kept leaking: **what a
tool *used to* do belongs in `whats-new.md` and nowhere else.** Issue #99 found
it in two other places. The main guide narrated past releases ("broken for three
releases, so an agent may have learned to route around it"), which is resident
in every session and — by naming the route-around — teaches it. And projects'
own docs carried workarounds written by earlier sessions, with nothing to remove
them when a release fixed the bug. The guides are the docs agent's problem
(present tense, rule plus reason, at most a "measured on 26.3, contradicts
Adobe's docs" tag); the project docs are what the machinery below is for.

Three parts, and each is only useful because of the other two:

- **`whats-new.md` has a shape a machine can filter.** One `## <semver>`
  section per release, newest first; everything above the first is the
  preamble; each entry is a bullet opening with the **rule as it now stands**,
  and under it indented `supersedes:` lines quoting the *old* rule in the words a
  project doc would have used — `run_batch is one undo step`, `reorder_layer is
  broken, use run_jsx` — so it can be grepped for. The contract sits in a comment
  at the top of the file. `tests/unit/whats-new.mjs` holds it: every `##` a
  release, strictly newest first, a section for the version being built or
  newer (so a release cannot ship without one), every entry bold-first, every
  `supersedes:` line inside a bullet and free of markdown. Only rules that have
  shipped get a `supersedes:` line; one for an unshipped change would send the
  absorb flow deleting a rule that is still true.
- **`ae_guide({topic: "whats-new", since})` returns the delta.** Sections
  strictly newer than `since` — the version named is the one already absorbed —
  behind the preamble, with the server's version on the first line so the agent
  can record it. Nothing newer is one explicit sentence, never an empty string:
  an agent cannot tell "up to date" from "broken" by an empty answer. The compare
  is numeric (`0.10.0` > `0.9.0`); `since` is validated as a version by the
  schema and refused on any other topic, since a filter that silently did not
  apply is the swallowed error this repo refuses elsewhere. `tools/whatsNew.ts`.
- **The absorb-release prompt applies it, once per release per project.**
  `prompts/absorb-release.md`, generated into the MCP prompt and the Claude Code
  command like the others. It finds `Tools version last absorbed: <version>` in
  the project's docs (the scaffold writes it — see "The project scaffold" in [subsystems.md](subsystems.md)),
  reads the delta, greps the project's CLAUDE.md / AGENTS.md / rules files /
  `.ae-mcp/` notes for every `supersedes:` line and proposes a rewrite or
  deletion of each hit (their docs — shown, approved once, never edited
  silently; prefer deleting, since a note that mentions a workaround teaches
  it), checks each *reported* journal entry's issue with `gh issue view` and
  `archive_issue`s the ones closed as completed (never `NOT_PLANNED`, never a
  `kind: "ae-quirk"` entry — those describe After Effects, which a release does
  not change), then writes the server version back into the marker. After that
  the history is not loaded again for that project. The detection is
  client-side and stated in the prompt: at session start compare the recorded
  version with `serverVersion` from `list_known_issues` (or the first line of
  any whats-new answer). There are **two** versions that update separately —
  the MCP server and, in Claude Code, the plugin carrying the skills — and the
  flow records the server's, because the server is what answers calls.

The generator needed nothing new for any of this: a prompt is a prompt. What
had to be *added* was the version in the answer, because the guide cannot carry
it — `packageVersion()` reads package.json at runtime, the same way the journal
reports it, so it says what the user actually installed.

