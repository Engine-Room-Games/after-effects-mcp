---
name: sound
reference: after-effects
description: Sound effects and beds through the AE MCP tools — place_audio_cues for a whole cue list in one undo step, what levelDb actually means and why a level copied from another cue is meaningless, the dry run, and the audio facts a hand-written loop gets wrong. Load when a task places, levels or times sound.
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
without importing, creating, or even adding an undo step, and names the cues
that would fail. Each cue names its sound with exactly one of `path` or
`footageId`; `inPoint` and `outPoint` trim in **comp** time, not file time; the
per-cue fields the tool accepts beyond those are in its schema.

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
- **Read the level back.** The result echoes the `levelDb` written for every
  cue it placed; later, `run_jsx` with
  `return layerById(compId, layerId).audioLevels.value` reads it off the layer.
  Ask the user to preview if they can — a level is the one property in this
  toolset that no screenshot can check.

## Timing

Cue times are comp times, and a cue placed in a shot comp is at that comp's
local time, so a cue list for a master and a cue list for a shot are different
lists — put a sound where the thing that makes it lives. Comp markers at the
beats (the `assembly` topic) are the right skeleton for a cue list, and a cue's
`name` is worth setting to the beat it belongs to.

## Scripting sound by hand

The raw-scripting facts — `layer.audioLevels` rather than a property lookup,
`layer.timeRemap` for a loop, and the Time Remap keys that must not be cleared
— are in the `extendscript-gotchas` topic.
