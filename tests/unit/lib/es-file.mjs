// ExtendScript's File and Folder, backed by the real filesystem — for running
// the jsx copies of the file checks that moved to the server (issue #220,
// stage 2) against the same folders as their TypeScript ports.
//
// It models the ExtendScript behaviour those checks rely on, as measured and
// written down in the jsx and in docs/fragile-areas-ae.md, and nothing else:
//   - `fsName` is the absolute, normalised path; `~` is the home folder.
//   - `File.read` consumes a UTF-8 BOM and normalises CR and CRLF to "\n".
//   - `open` answers false rather than throwing when the OS refuses.
//   - `Folder.create` makes every missing parent.
// What it cannot know is whether After Effects really does each of these on
// every platform; that is what the live recipes named in the PR re-check.
//
// The classes are returned for injection into a vm context, so the jsx sees
// them as its globals `File` and `Folder`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveEs(p) {
  let s = String(p);
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

export class EsFolder {
  constructor(p) { this._p = resolveEs(p); }
  get fsName() { return this._p; }
  get exists() { return fs.existsSync(this._p); }
  get parent() {
    const d = path.dirname(this._p);
    return d === this._p ? null : new EsFolder(d);
  }
  create() {
    try { fs.mkdirSync(this._p, { recursive: true }); return true; } catch { return false; }
  }
}

export class EsFile {
  constructor(p) {
    this._p = resolveEs(p);
    this.encoding = "BINARY";
    this.lineFeed = "Macintosh";
    this._fd = null;
    this._mode = null;
  }
  get fsName() { return this._p; }
  get exists() { return fs.existsSync(this._p); }
  get length() { try { return fs.statSync(this._p).size; } catch { return -1; } }
  get parent() {
    const d = path.dirname(this._p);
    return d === this._p ? null : new EsFolder(d);
  }
  open(mode) {
    try {
      if (mode === "r") {
        // Read access is what open("r") establishes; a directory is not a file.
        if (fs.statSync(this._p).isDirectory()) return false;
        fs.accessSync(this._p, fs.constants.R_OK);
        this._mode = "r";
        return true;
      }
      if (mode === "w") {
        this._fd = fs.openSync(this._p, "w");
        this._mode = "w";
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
  read(max) {
    if (this._mode !== "r") return "";
    const text = fs.readFileSync(this._p, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    return max === undefined ? text : text.slice(0, max);
  }
  write(s) {
    if (this._mode !== "w" || this._fd === null) return false;
    // lineFeed "Unix" writes "\n" as given; "Macintosh" turns each into "\r".
    const text = this.lineFeed === "Unix" ? String(s) : String(s).replace(/\n/g, "\r");
    fs.writeSync(this._fd, text, null, "utf8");
    return true;
  }
  close() {
    if (this._fd !== null) { try { fs.closeSync(this._fd); } catch {} }
    this._fd = null;
    this._mode = null;
    return true;
  }
  remove() {
    try { fs.unlinkSync(this._p); return true; } catch { return false; }
  }
}

/** A fresh empty folder under the OS temp dir, real path (macOS /var -> /private/var). */
export function scratchDir(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ae-mcp-${tag}-`)));
}

/** Run `fn`, returning `{ok, value}` or `{ok:false, message}` — the shape both copies are compared in. */
export function outcome(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, message: String(e && e.message ? e.message : e) };
  }
}

/** Every file and folder under `dir`, with each file's bytes, for comparing what two runs left on disk. */
export function snapshotTree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel ? rel + "/" + name : name;
      if (fs.statSync(full).isDirectory()) { out[r + "/"] = null; walk(full, r); }
      else {
        try { out[r] = fs.readFileSync(full).toString("base64"); }
        catch { out[r] = "<unreadable>"; }
      }
    }
  };
  walk(dir, "");
  return out;
}

/** Empty `dir` (and restore permissions first, so a read-only scenario can be undone). */
export function resetDir(dir) {
  const walk = (d) => {
    try { fs.chmodSync(d, 0o755); } catch {}
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      try { fs.chmodSync(full, 0o755); } catch {}
      if (fs.statSync(full).isDirectory()) walk(full);
    }
  };
  walk(dir);
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}
