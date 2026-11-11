// Where After Effects writes a frame for this server to read.
//
// The server names the folder and the panel writes into it (`__frameDir` on
// the three raw image ops). It used to be the panel's choice, ExtendScript's
// `Folder.temp`, and on macOS that is `<tmp>/TemporaryItems` — a folder where
// a second program may stat a file After Effects wrote and is refused when it
// opens or deletes it. That was invisible while the panel read its own frames
// and broke every screenshot the day the server started reading them (issue
// #299; measured on macOS 26.6: stat ok, open EPERM, unlink EPERM, while the
// same write to `<tmp>` itself and to the folder below read back fine).
//
// So the folder is one both sides already prove they can use: the panel writes
// its port and token files into `~/.engineroom-ae-mcp`, and every server reads
// them from there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A frame nobody collected is this old before the next server removes it. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const FRAME_FILE = /^ae-mcp-\d+-\d+\.png$/;

export function defaultFrameDir(): string {
  return path.join(os.homedir(), ".engineroom-ae-mcp", "frames");
}

/**
 * Make the folder and clear out frames a crashed or killed server left in it.
 * Resolves to the folder, or to null when it cannot be made — the panel then
 * falls back to its own temp folder, and a read refused there is reported as
 * FRAME_UNREADABLE rather than guessed at.
 */
export function prepareFrameDir(dir: string, now: number = Date.now()): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!FRAME_FILE.test(name)) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > ORPHAN_AGE_MS) fs.unlinkSync(file);
      } catch {
        /* another server took it first */
      }
    }
  } catch {
    /* an unlistable folder can still be written to; the read will say if not */
  }
  return dir;
}
