---
name: style-guide
description: Help a motion designer capture their house style — palette, type, motion and layout — into the house-style.md file that sits next to their After Effects project and shapes everything built afterwards. Load when the user asks to create, edit or review their style guide, when they say work does not look like theirs, or when get_house_style reports none exists.
---

# Capturing a house style

A house style is the difference between an assistant that builds *a* lower third
and one that builds *their* lower third. It lives in `house-style.md` beside the
`.aep` file, and `get_house_style` reads it before any build task.

Your job here is to get one written with as little effort from the user as
possible. They are a motion designer. They know exactly what their work looks
like and will struggle to dictate it as a specification — so do not ask them to.

## Two ways in. Prefer the first.

### 1. Read it off work they already like

This is far better than any questionnaire, because it produces real numbers
instead of adjectives.

1. Ask which comp to learn from — "point me at something that looks the way you
   want everything to look."
2. `get_comp` for size and frame rate, then `get_layer_full` on the layers that
   carry the look: the text, the background, the accent shapes.
3. Pull out the concrete values — hex colours, font families and sizes, tracking,
   corner radii, stroke widths, the position of things relative to the frame.
4. Read the keyframes too. `get_keyframes` plus the ease settings tell you the
   timing signature: how long a standard in-animation takes, whether it
   overshoots, whether anything is ever linear.
5. Show them what you found, in their language, and ask what to change:

   > Here's what I read off that comp: near-black background `#0B0D12`, white
   > text in Inter Semibold at 64px with slightly tight tracking, one green
   > accent `#3DC46E`. Things scale in over about 0.4s with an overshoot to 108%
   > and easy ease on both ends. Nothing sits perfectly still — there's a slow
   > wiggle on the chip. Does that sound like your style, or was that comp a
   > one-off?

6. Write it with `set_house_style`.

### 2. Ask, when there is nothing to read

Only if the project is empty or they have no reference. Keep it to four
questions, and offer concrete options rather than open ones — "dark or light
background?" beats "what's your palette?". Then build one small example, show it
with `screenshot_frame`, and refine from their reaction. Reacting is easier than
specifying.

## What makes a guide that actually works

**Numbers, not adjectives.** `#131521 at 92% opacity` is usable. "Dark and clean"
is not. If a corner radius, a stroke width or a hold duration matters, write the
number. Anything vague will be silently reinterpreted every time it is read.

**Rules, not just values.** The most valuable lines are the prohibitions: "never
put text directly on footage — always on a rounded chip", "keep total runtime
under 8 seconds", "no linear motion unless something mechanical is moving".
Those are what stop work drifting.

**Only what you verified.** Do not pad the file with plausible-sounding defaults
they never asked for. A short guide that is true beats a complete one that is
half invented. Leave a heading empty rather than filling it with a guess.

## Keep it current

When the user corrects the same thing twice — "no, the accent green, not the
blue" — that is a missing rule, not a one-off. Offer to add it:

> I've had to switch that green twice now. Want me to put it in the style guide
> so it's the default from here?

Read the existing guide with `get_house_style` before writing, and preserve what
is already there. `set_house_style` replaces the whole file, so send back the
full document, not just your additions.

## The one thing to warn them about

`house-style.md` is written next to the `.aep`, so **the project has to have been
saved at least once** — an unsaved project has no folder to write into, and
`get_house_style` will say so. If that happens, ask them to save the project
first, then write the guide.

The file is plain markdown. Tell them where it is and that they can edit it in
any text editor without going through you.

## Starting point

When writing a guide from scratch, this is the shape to fill in. Drop headings
you have nothing real to put under.

```markdown
# House style

## Palette
| Role | Colour | Notes |
|---|---|---|
| Background | `#0B0D12` | |
| Primary text | `#FFFFFF` | |
| Accent | `#3DC46E` | Emphasis and positive values |
| Negative | `#E03333` | |

## Type
- Headings: Inter Semibold, 56–72px, tracking -10
- Body: Inter Regular, 28–34px
- Left-aligned unless stated otherwise

## Motion
- Standard in: scale 0 → 108 → 100, easy ease, ~0.4s
- Standard out: scale → 0, ~0.3s
- Easy ease on everything; no linear motion unless mechanical
- Subtle wiggle on position so nothing sits perfectly still

## Layout
- 1920×1080 at 30fps
- 120px safe margin from every edge
- Lower thirds sit bottom-left, above the margin

## Rules
- Never put text directly on footage — always on a rounded chip
- Total runtime under 8 seconds
```
