---
name: sound
reference: after-effects
description: Sound effects and beds through the AE MCP tools — place_audio_cues for a whole cue list in one undo step, what levelDb actually means and why a level copied from another cue is meaningless, peak for a one-shot and RMS for a bed with the onset on the beat, loops, fades and stretch per cue, a trim clamped at the file's end, a bed that follows a move, the dry run, a file that will not place, and the audio facts a hand-written loop gets wrong. Load when a task places, levels or times sound.
---

# Sound

`place_audio_cues` scores a scene in one call: a list of cues — each a file (or
an already-imported `footageId`), a comp `time` and a `levelDb` — becomes one
audio layer each, imported once however many cues name the same file, named,
trimmed, labelled, in a single undo step. Reach for it the moment you are
placing more than two or three sounds; the alternative is dozens of round trips
or a `run_jsx` loop that has to know that `layer.property("ADBE Audio Levels")`
returns null on an audio layer.

It is **all-or-nothing**: every cue is checked (the file exists, the item has
an audio track, the time is inside the comp) before a single layer is made, and
if a later one still fails, everything the call created is removed and the
error names the cue by index. `dryRun: true` checks a list against the project
without importing, creating, or even adding an undo step, and answers with
counts, `wouldImport`, `wouldReuse` and the failing cues by index — never the
resolved list. Each cue names its sound with exactly one of `path` or
`footageId`; `inPoint` and `outPoint` trim in **comp** time, not file time. An
`outPoint` past the file's placed length — its duration times `stretch` — is
clamped to it without a word, so read the out point back from the result; a
sound that must run longer is `loop: true`, not a longer trim.

## Levels

`levelDb` is decibels, After Effects' own unit: **`0` is the file as recorded**,
negative is quieter, and it is written explicitly even when you omit it. Two
things follow:

- **A level copied from another cue is meaningless.** Files in one sound bank
  routinely differ by 30 dB as recorded — a whoosh mastered hot and a room tone
  mastered quiet — so `-6` on one is nothing like `-6` on the other. Measure
  before you set: peak and RMS of the file (`ffmpeg -af volumedetect`, `sox
  stat`, or whatever the shell has; where there is no shell, ask the user what
  the file sounds like against the others), then choose a level that brings it
  to where you want it, not a number that looked right last time.
- **Read the level back off the layer.** The result carries one small entry
  per cue — `layerId`, `name`, `time`, and what an option changed — and does
  not echo the level; `run_jsx` with
  `return layerById(compId, layerId).audioLevels.value` reads it. Ask the user
  to preview if they can — a level is the one property in this toolset that no
  screenshot can check.
- **Match a one-shot by peak and a bed by RMS.** A hit is heard at its peak
  and a bed at its average, so a bed levelled by peak sits too low and a hit
  levelled by RMS jumps out. And put the file's *onset* on the beat, not its
  start: a one-shot with silence before the hit goes at `time: beat − onset`
  with `inPoint: beat` to trim the silence, which is also how a hit is
  shortened under a visual shorter than the file.

## Loops, fades and stretch

Three per-cue options cover what a scoring pass otherwise redoes in `run_jsx`,
and each moves something After Effects then quietly resets — which is the
reason to take them from the tool rather than script them:

- **`loop: true`** repeats the sound to the cue's `outPoint`, or to the end of
  the comp when there is none — beds and ambiences. It enables time remapping
  with a wrap-around expression on Time Remap, keeps the two keyframes AE
  creates (removing them hides the property), and re-asserts the out point,
  because enabling remapping resets it. `inPoint` still trims the front of the
  file the way it does on any layer.
- **`fadeIn` / `fadeOut`**, in seconds, keyframe Audio Levels at the in and
  out point the layer actually has, between the call-level `fadeFloorDb`
  (default `-48`, the bottom of AE's own slider) and the cue's `levelDb`. A
  fade that does not fit the cue's placed length, or a floor at or above the
  cue's level, is refused by cue index with nothing placed; for a file not yet
  imported the fit is checked right after the import, before any layer exists.
  The result carries `fadeFloorDb` when any cue faded.
- **`stretch`** is a percentage: `100` unchanged, `200` half speed at a lower
  pitch. The start time and any trims are re-asserted after it, because AE
  moves them when stretch changes. A loop that is also stretched has the factor
  baked into its expression, so changing the stretch by hand afterwards leaves
  the loop wrapping at the old rate — set it here, or place the cue again.

Every option is validated with the rest of the list before anything is
created, and the result names what an option changed — `looped`, `stretch`,
`fadeIn`, `fadeOut`, and the in and out point read back — only on the cues it
applied to.

## Timing

Cue times are comp times, and a cue placed in a shot comp is at that comp's
local time, so a cue list for a master and a cue list for a shot are different
lists — put a sound where the thing that makes it lives. Comp markers at the
beats (the `assembly` topic) are the right skeleton for a cue list, and a cue's
`name` is worth setting to the beat it belongs to.

A sound that belongs to a move follows the move. Under an eased camera, a bed
run at a constant rate and level comes apart from the picture at every ease;
drive the bed's Time Remap from the distance the camera has travelled and its
level from the camera's `speed` (expressions on the audio layer reading the
null's position), so it slows, stops and rises with the move.

## A file that will not place

A file that imports with no audio track, or refuses to import at all, is worth
checking for its sample format before anything else: a 32-bit float WAV
(format tag 3) is the usual case. Convert it to 16-bit PCM — `afconvert -f
WAVE -d LEI16 in.wav out.wav` on macOS, `ffmpeg -i in.wav -c:a pcm_s16le
out.wav` anywhere — and keep a sound bank at 16-bit PCM so it never comes up.

## Scripting sound by hand

The raw-scripting facts — `layer.audioLevels` rather than a property lookup,
`layer.timeRemap` for a loop, and the Time Remap keys that must not be cleared
— are in the `extendscript-gotchas` topic.
