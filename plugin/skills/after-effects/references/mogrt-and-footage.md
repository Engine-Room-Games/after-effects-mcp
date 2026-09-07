---
name: mogrt-and-footage
reference: after-effects
description: Exporting a Motion Graphics template and importing footage through the AE MCP tools — export_mogrt and the preconditions it checks before touching the project, the thumbnail, the modal dialogs that freeze this connection, and the SVG whose viewBox makes After Effects fabricate dimensions and render nothing. Load when a task exports a .mogrt or imports a file.
---

# Motion Graphics templates and footage

## Exporting a Motion Graphics template

Use **`export_mogrt`**. Do not drive `comp.exportAsMotionGraphicsTemplate`
from `run_jsx`: that call raises modal dialogs, and a modal dialog freezes this
whole connection until someone clicks it in After Effects — but suppressing
them, which is what you have to do, costs you the only channel AE has for saying
why an export failed. It answers with a bare boolean and nothing else. So the
tool checks every precondition it can *before* exporting, which is the half of
the job a script cannot do.

`export_mogrt` saves the project first (which removes AE's "the project needs to
be saved" prompt, and has to happen per export because exporting dirties the
project again), suppresses the font warning, and runs outside the undo group so
there is no "undo group mismatch" afterwards. Measured on 26.3: suppressed, an
export of a comp using a non-Adobe font returns in about three seconds;
unsuppressed, the same export blocks past sixty and writes nothing until the
dialog is clicked.

Four things to know before you call it. The first is the one that actually
stops exports:

- **The comp needs at least one property in its Essential Graphics panel.**
  After Effects will not build a template from an empty one, and it refuses
  silently — no file, no dialog, not a word. The tool checks the controller
  count first and refuses before touching anything. The fix is in AE and the
  user has to do it: Window > Essential Graphics, pick the comp, drag a layer
  property in.
- **The project must have been saved once, by hand.** There is no folder to
  save into otherwise, and the tool refuses rather than raising a dialog the
  user was not expecting.
- **`name` is the filename.** It defaults to the comp name, because AE's own
  default is the literal `Untitled` — leave it to AE and every template in the
  project overwrites the same file. `overwrite: true` is required to replace an
  existing one.
- **`fonts` in the result lists what the template will require.** Tell the user
  about any non-Adobe ones: Premiere flags the template as needing fonts it
  cannot supply, and that is worth hearing from you rather than discovering
  later.

**If an export fails anyway, read the message rather than guessing.** It lists
what was checked and ruled out, and it only names a modal dialog when dialogs
were left *unsuppressed*. Under the default suppression a dialog is impossible
by construction, so the cause is genuinely unknown — say so, and tell the user
the one place AE's own reason exists: exporting the same comp by hand from the
Essential Graphics panel, where AE shows its error in the interface. Do not
send them looking for a dialog that cannot be there.

**The thumbnail.** AE writes the comp's *first frame* into the template, so
anything that fades up from nothing gets a black one. Pass `posterTime` with a
moment that actually shows the design and it is rendered and swapped in. If
only the thumbnail fails the export still succeeds — check `thumbnail.patched`
in the result.

`comp.setMotionGraphicsControllerName(index, …)` numbers controllers in
**reverse order of addition**: index 1 is the one added last.

**If any long call seems to have hung, assume a dialog before you assume a
crash** — it may be behind another window. `comp.saveFrameToPng(...)` from
`run_jsx` raises the save prompt the same way; use `screenshot_frame`, which
does not.

## Importing footage, and the SVG trap

Use **`import_footage`**, then **`create_footage_layer`** to place the item in
a comp. (For a comp as a layer, `create_precomp_layer`.)

`import_footage` checks what AE actually produced, because one case fails
silently: an SVG with a very large `viewBox` (say `0 0 278050 333334`) imports
with **fabricated dimensions and renders as nothing**, no error at any stage.
Measured on 26.3: that viewBox yields a 15906×5654 item that will not even
rasterize, and the numbers depend only on the viewBox. The tool compares the
aspect ratio the file asks for against the one AE produced, and on a mismatch it
deletes the item and throws, rather than handing you an asset that looks healthy
in the project panel and renders empty.

If you hit that, the workarounds are:

- **Simple flat SVGs** — rebuild the path as a shape layer with the real
  vertices, scaled down to a sane coordinate space (divide by `333.334` for a
  1000px version), set the fill from the SVG, and set `ADBE Vector Fill Rule`
  to `2` when the SVG says `fill-rule="evenodd"`. Done this way the result is
  pixel-accurate.
- **Complex SVGs** — rasterise to PNG outside AE, or normalise the `viewBox` to
  a small coordinate space before importing.

`force: true` keeps the item and reports the problem in `validation` instead of
throwing. It is for when you know the dimensions are wrong and want it anyway —
not a way past the error.

Deleting a comp does not delete the footage its layers pointed at — a solid's
footage item lives in the project's Solids folder, not in the comp — so a
workflow that builds and discards comps grows the project bin without bound.
`delete_comp({…, purgeUnusedSolids: true})` removes the solids nothing else
uses once the comp is gone, and `purge_unused_footage` does the same for every
unused item project-wide; both name what they removed and what they left, so
read that rather than assuming the bin is clean.
