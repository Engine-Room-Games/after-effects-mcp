---
name: init-after-effects
description: Set up After Effects from scratch — install the panel, create a project folder, and capture a house style
argument-hint: "[folder to set the project up in, if you know it]"
---

# Set up After Effects

The user has just connected these tools and wants to start working. Take them
all the way from nothing to a first build. They are a motion designer, not a
developer — they should never be asked to open a terminal, edit JSON, or read a
file path they did not ask about.

`$ARGUMENTS` is the folder they named, if they named one.

Work through these in order, and **stop at the first one that needs something
from them**. Do not run ahead and report four steps at once.

## 1. Is After Effects reachable?

Call `check_setup`. It is read-only and safe.

- **Everything green** — say so in one line and move on.
- **Anything red** — this is the one step that cannot be skipped. Explain what
  `setup_panel` is about to do before calling it: it copies a small panel into
  their Adobe extensions folder and switches on the Adobe setting that allows
  unsigned panels. Both are user-level and reversible. Call it, then ask them to
  **quit and reopen After Effects** — the panel only loads at launch, and you
  cannot do it for them. Then `check_setup` again to confirm.

If it still fails, load the `ae-setup` topic of `ae_guide` and work through it.
Do not improvise CEP diagnostics.

## 2. Where does the project live?

Call `init_project`. Pass `dir` when you know it — from `$ARGUMENTS`, or from
what the user says. If you do not know, **ask before calling**: "which folder
should this project live in? A new empty one is fine."

Never invent a path. If the tool reports it could not work out where to write,
that is exactly what it means — ask, then call again with `dir`.

Tell them the folder it created and what is in it, in one sentence. Do not paste
the file list.

## 3. Do they have a project open?

Ask them to open the After Effects project they want to work on — or to create
and **save** one. Saving matters: the style guide is written next to the .aep,
and an unsaved project has no folder to put it in.

`get_project_summary` will tell you what is open.

## 4. Offer a style guide

Call `get_house_style`. If one already exists, say what it covers and stop —
they are set up.

If not, offer it in their terms:

> Do you want me to set up a style guide? If you point me at a comp that already
> looks the way you like, I'll read the colours, fonts and timing off it and save
> them next to your project. Everything I build afterwards follows it.

If they say yes, load the `style-guide` topic of `ae_guide` and follow it — read
a comp they nominate, show them what you found in plain language, and write it
with `set_house_style`. If they say no, drop it; it can be offered again later.

## 5. Hand over

Close with one short paragraph: they are set up, and here is the kind of thing
they can now ask for. Give one concrete example rather than a list of features:

> You're set. Try something like "build a lower third that says Chapter One and
> slides in from the left" — I'll read the comp, build it, and you'll see it
> happen in After Effects.
