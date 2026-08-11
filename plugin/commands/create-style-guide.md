---
name: create-style-guide
description: Capture or update the look of this project — palette, type, motion and layout — into the style guide that shapes everything built afterwards
argument-hint: "[the comp to learn the style from, if you have one in mind]"
---

# Set up the style guide

The user wants everything you build to look like *their* work rather than
generic motion graphics. That is what the style guide is for. It is saved as
`house-style.md` next to their After Effects project and read before every build.

`$ARGUMENTS` may name a comp to learn from.

Load the `style-guide` topic of `ae_guide` and follow it. In short:

1. `get_house_style` first. If one exists, you are editing, not creating — read
   it, keep what is there, and send the whole merged document back.
2. Prefer reading the style off work they already like over asking them to
   describe it. Ask which comp, then `get_comp` and `get_layer_full` on the
   layers that carry the look, and `get_keyframes` for the timing signature.
3. Show what you found in plain language and let them correct it. Adjectives
   from you, numbers in the file.
4. Write it with `set_house_style` (`overwrite: true` when replacing), then tell
   them where it is and that they can edit it in any text editor.

Two things that will stop you: the project must have been **saved** at least
once, and `set_house_style` replaces the whole file rather than patching it.

If they have nothing to learn from, do not run a long interview. Ask four
questions with concrete options, build one small example, screenshot it, and
refine from their reaction — reacting is much easier than specifying.
