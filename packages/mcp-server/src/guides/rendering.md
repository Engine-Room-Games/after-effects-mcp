---
name: rendering
reference: after-effects
description: Rendering comps to files through the AE MCP tools — add_to_render_queue with output-module templates, render_queue as a background job rendered by aerender from the saved project, await_job for progress, cancel_job, and why a template name is chosen and then checked rather than trusted. Load when a task renders, exports a movie or an image sequence, or touches the render queue.
---

# Rendering

Rendering is two steps: **queue**, then **render**.

1. `add_to_render_queue({compId, outputPath, outputModuleTemplate?, renderSettingsTemplate?})`
   puts one item in After Effects' Render Queue. It renders nothing.
2. `render_queue({indices: [the index add_to_render_queue returned]})` renders
   those items and answers at once with a `jobId`. Then
   `await_job({jobId, timeoutMs})`. `all: true` instead of `indices` renders
   every QUEUED item — including ones the user queued by hand for their own
   reasons. Use it only when the user asked for the whole queue.

## Formats are templates, chosen by name

A script cannot set an output module's format, codec, bit depth, channels or
color — After Effects reports them as read-only. The only way to get, say,
ProRes 4444 with alpha is an **output module template** that already says so.

- Pass the template's name. An unknown name is refused with the list of names
  that exist on this machine; `list_render_queue({includeTemplates: true})`
  shows the same list once the queue has an item in it.
- If no template gives what the user needs, ask them to make one once:
  *Edit > Templates > Output Module*, *New*, set it up, name it. Templates live
  in After Effects' preferences, so one covers every project.
- **Read back before you promise.** The result carries
  `outputs[0].settings` — `format`, `channels`, `depth`, `color` — as After
  Effects will actually write them. A template called "…with Alpha" whose
  codec cannot carry alpha reports `channels: "RGB"`; that is the answer.
- After Effects may change the extension to match the format. The path in the
  result is the file that will be written.

## What render_queue does, and what to tell the user

- **It renders the saved file.** The render runs in a separate background copy
  of After Effects (`aerender`) that reads the `.aep` on disk. With unsaved
  changes it refuses unless you pass `saveProject: true` — tell the user the
  project will be saved before you pass it. A clean project is never saved,
  except to fix footage paths (below), and only with `saveProject: true`. A
  project never saved, read-only, or converted from an older After Effects
  (which only *Save As* will write) is refused; the user fixes that by hand.
- **Missing footage the render draws is refused before rendering**, with the
  missing items named — relink them first (File > Dependencies > Find Missing
  Footage). Missing footage only on switched-off layers, or on layers outside
  the rendered time span, is not a reason to refuse: it comes back in
  `missingFootageNotRendered` — mention it to the user. A switched-off layer
  still counts as drawn when it is a track matte or another layer's effect
  points at it (Displacement Map, Set Matte, a Layer Control). When an
  expression calls `sampleImage()`, those skips come back as `footageWarnings`
  instead, because the expression may read them: tell the user, and look at
  those frames.
- **Footage the saved project records at an old location is refused** — the
  project folder was moved and not saved since, so After Effects found the
  files only relative to the project, which the render's copy cannot do. The
  refusal names the files; pass `saveProject: true` (tell the user — this
  saves a project with no unsaved changes) and the save records where they
  are now. Footage After Effects still shows but whose file is gone from disk
  (deleted or moved while the project was open) is refused outright. If the
  result carries `footagePathsUnchecked`, the project's format could not be
  read for that check (an older project, say): the render runs anyway — open
  the output and look before calling it done.
- **Existing files are refused** unless `overwrite: true` — that includes an
  item the user queued by hand that points at last week's render.
- **One output path, one item.** aerender will not render an item whose
  output another item in the queue also has — and it fails silently, writing
  nothing. Every item counts except a *Done* one, including one already
  rendered by `render_queue` (*Unqueued*), and two image sequences with the
  same `[####]` pattern count even over separate frame ranges. So
  `add_to_render_queue` refuses such a path, and `render_queue` refuses before
  rendering; `overwrite: true` does not lift either. The refusal names the other
  item with the exact `remove_render_item({index, compId})` call that clears it.
  **To render a comp again to the file its last render wrote**: the old item
  cannot be re-queued — `render_queue` renders only QUEUED items, no tool ticks
  an item back on, and `render_queue` leaves what it rendered *Unqueued* — so
  remove the old item with `remove_render_item` (its file stays on disk), then
  `add_to_render_queue` again with `overwrite: true` and render the new index.
  Paths are compared as the same file, so a different case or a symlinked
  folder still counts.
- **Edits made while it renders are not in the render.** The render reads a
  private copy in the system temp folder taken at its start, so neither your
  later edits nor a save by the user mid-render change it. After Effects stays
  fully usable.
- **It is slow to start.** The background copy takes several seconds to launch,
  and progress sits at 0 until the first frame.
- **One render at a time.** A second `render_queue` is refused while one runs.
- **Rendered items are switched off, as one undo step.** When the job ends —
  finished, failed or cancelled — every item whose file was verified has its
  Render box unticked (status *Unqueued*), so the next `render_queue` does not
  render it again. That is a change to the user's project and lands in their
  undo history as one step, *AE MCP: mark rendered*, at the moment the render
  finishes; tell them, so an unexpected entry in Edit > Undo is not a mystery.
  `unqueued.marked: false` on an item means the queue changed during the
  render and that item was left alone — say so.

## Waiting, and the result

`await_job` blocks until the render ends. Its default timeout is 10 minutes —
pass a larger `timeoutMs` for anything long, and a progressToken if you want
per-frame progress. A timed-out `await_job` does **not** stop the render; call
it again, or `get_job` to look without waiting.

A completed render lists every output file **checked on disk**: it exists, is
not empty, and was written by this render. A render that exited cleanly but
left no file, or left only the file from a previous render, is reported as a
failure with aerender's own last lines — believe it, and do not tell the user
the render worked.

## Cancelling

`cancel_job({jobId})` ends the aerender process. `stopped: true` comes back
only once the process has actually exited. The interrupted item's file **may
be incomplete** — the render was stopped before After Effects confirmed it
finished — and is left on disk in `partialFiles`. A cancel near the end can
leave a complete file, so check its duration or frame count before using or
deleting it, and never present it as a finished render unchecked. Items in
`rendered` finished before the cancel and are good. If `partialFiles` is empty
and the note says After Effects' unfinished file was discarded, there is no
partial file to find. A file that was at the output path before the render (an
earlier render, with `overwrite:true`) is never listed in `partialFiles` and is
not replaced by the cancel; the partial is then named at its temp-folder path.
Each partial file is named exactly — delete by those names, never by a
`[####]` pattern or a folder.
