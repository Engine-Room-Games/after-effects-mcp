---
name: rendering
reference: after-effects
description: Rendering comps to files through the AE MCP tools — add_to_render_queue with output-module templates, render_queue as a background job rendered by aerender from the saved project, await_job for progress, cancel_job, and why a template name is chosen and then checked rather than trusted. Load when a task renders, exports a movie or an image sequence, or touches the render queue.
---

# Rendering

Rendering is two steps: **queue**, then **render**.

1. `add_to_render_queue({compId, outputPath, outputModuleTemplate?, renderSettingsTemplate?})`
   puts one item in After Effects' Render Queue. It renders nothing.
2. `render_queue({indices?})` renders every QUEUED item (or the ones named)
   and answers at once with a `jobId`. Then `await_job({jobId, timeoutMs})`.

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

- **It saves the project.** The render runs in a separate background copy of
  After Effects (`aerender`) that reads the saved `.aep`, so it saves first.
  Say so before calling it. A project that has never been saved is refused —
  the user saves it once by hand.
- **Edits made while it renders are not in the render.** After Effects stays
  fully usable and your other tools keep working; the render cannot see them.
- **It is slow to start.** The background copy takes several seconds to launch,
  and progress sits at 0 until the first frame.
- **One render at a time.** A second `render_queue` is refused while one runs.
- **The Render Queue panel will not change.** The items still read *Queued*
  afterwards, because they were rendered from the file, not by the panel.
  Calling `render_queue` again renders them again. `remove_render_item` takes
  them out.

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
only once the process has actually exited. The interrupted item's file is
**incomplete** and is left on disk in `partialFiles` — tell the user, or delete
it, but never present it as a render. Items in `rendered` finished before the
cancel and are good.
