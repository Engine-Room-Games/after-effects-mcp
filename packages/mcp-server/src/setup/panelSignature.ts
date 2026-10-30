import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The signed panel (issue #182), read without Adobe's tools.
 *
 * A panel signed with `ZXPSignCmd` carries two files its source does not:
 * `META-INF/signatures.xml` and `mimetype`. The XML holds an XML-DSig
 * signature over a manifest that lists **every file in the folder** with its
 * SHA-256 digest, `mimetype` included. CEP refuses the panel (unless
 * PlayerDebugMode is on and honoured) when any listed file is missing or
 * differs, or when a file the manifest does not list is present — measured
 * with `ZXPSignCmd -verify` 4.1.3, which is the library CEP itself loads. Two
 * things it ignores, also measured: `.DS_Store` files at any depth, and empty
 * directories.
 *
 * What this module does NOT do is check the RSA signature or the certificate:
 * that needs Adobe's code. It checks the far likelier failure — files that
 * changed after signing, which is what a dev sync (`AE_MCP_SYNC_PANEL=1`), a
 * `/reload-jsx` edit, a hand-copied `ws` or a half-finished install all do.
 * The packaging step runs the real `ZXPSignCmd -verify` as well.
 *
 * Deliberately separate from the version gate (`panelVersion.ts`): the gate
 * asks "is this the panel these tools ship", this asks "will CEP accept the
 * signature on it" — and the gate must ignore `META-INF/signatures.xml` and
 * `mimetype` (issue #243), since a signed and an unsigned copy of one version
 * are the same panel.
 */

/** Relative path of the signature, with forward slashes as the manifest writes them. */
export const SIGNATURE_FILE = "META-INF/signatures.xml";
/** The other file signing adds. Listed in the manifest, unlike the signature itself. */
export const MIMETYPE_FILE = "mimetype";

/** Names CEP's verifier skips wherever they appear (measured). */
const IGNORED_NAMES = new Set([".DS_Store"]);

/** Does this folder carry a ZXPSignCmd signature at all? */
export function isSignedPanel(dir: string): boolean {
  return fs.existsSync(path.join(dir, ...SIGNATURE_FILE.split("/")));
}

export interface SignatureManifestEntry {
  /** Lower-case digest algorithm name Node's crypto knows, or null when the manifest names one it does not. */
  algorithm: string | null;
  /** Base64 digest as written in the manifest. */
  digest: string;
}

const ALGORITHMS: Record<string, string> = {
  "http://www.w3.org/2001/04/xmlenc#sha256": "sha256",
  "http://www.w3.org/2000/09/xmldsig#sha1": "sha1",
  "http://www.w3.org/2001/04/xmlenc#sha512": "sha512",
};

/**
 * The file manifest inside `signatures.xml`, keyed by relative path with
 * forward slashes. Null when there is no signature or no manifest in it.
 * Parsed with a pattern rather than an XML parser because the format is
 * written by one tool and is flat: `<Reference URI="…"><DigestMethod
 * Algorithm="…"/><DigestValue>…</DigestValue></Reference>`. The one Reference
 * with a `#` URI points at the manifest itself and is skipped.
 */
export function readSignatureManifest(dir: string): Map<string, SignatureManifestEntry> | null {
  let xml: string;
  try {
    xml = fs.readFileSync(path.join(dir, ...SIGNATURE_FILE.split("/")), "utf8");
  } catch {
    return null;
  }
  const start = xml.indexOf("<Manifest");
  if (start < 0) return null;
  const body = xml.slice(start);
  const out = new Map<string, SignatureManifestEntry>();
  const re =
    /<Reference\s+URI="([^"]*)"\s*>\s*<DigestMethod\s+Algorithm="([^"]*)"\s*\/>\s*<DigestValue>\s*([^<\s]+)\s*<\/DigestValue>\s*<\/Reference>/g;
  for (const m of body.matchAll(re)) {
    if (m[1].startsWith("#")) continue;
    let rel = m[1];
    try {
      rel = decodeURIComponent(rel);
    } catch {
      // Not percent-encoded after all; keep it as written.
    }
    out.set(rel, { algorithm: ALGORITHMS[m[2]] ?? null, digest: m[3] });
  }
  return out.size > 0 ? out : null;
}

export interface SignatureProblems {
  /** Listed in the manifest, present, with different contents. */
  modified: string[];
  /** Listed in the manifest, not on disk. */
  missing: string[];
  /** On disk, not listed — every one of these fails verification on its own. */
  extra: string[];
}

/** Relative paths (forward slashes) of every file under `root`, skipping what CEP skips. */
function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out;
}

/**
 * Would the signature on this folder still hold? Null when the folder is not
 * signed (or its manifest is unreadable — then there is nothing to compare
 * against). Otherwise every list is sorted; all three empty means the files are
 * exactly the ones that were signed.
 */
export function signatureProblems(dir: string): SignatureProblems | null {
  const manifest = readSignatureManifest(dir);
  if (!manifest) return null;
  const problems: SignatureProblems = { modified: [], missing: [], extra: [] };
  for (const [rel, entry] of manifest) {
    const file = path.join(dir, ...rel.split("/"));
    let bytes: Buffer;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) {
        problems.modified.push(rel);
        continue;
      }
      bytes = fs.readFileSync(file);
    } catch {
      problems.missing.push(rel);
      continue;
    }
    if (entry.algorithm === null) continue; // cannot judge it; the real verifier can
    if (crypto.createHash(entry.algorithm).update(bytes).digest("base64") !== entry.digest) problems.modified.push(rel);
  }
  for (const rel of listFiles(dir)) {
    if (rel === SIGNATURE_FILE) continue;
    if (!manifest.has(rel)) problems.extra.push(rel);
  }
  problems.modified.sort();
  problems.missing.sort();
  problems.extra.sort();
  return problems;
}

/** True when `signatureProblems` found nothing wrong. */
export function signatureIntact(problems: SignatureProblems | null): boolean {
  return !!problems && problems.modified.length + problems.missing.length + problems.extra.length === 0;
}

/** One line naming the first few problems, for a check's detail. */
export function describeSignatureProblems(p: SignatureProblems, max = 4): string {
  const parts: string[] = [];
  const fmt = (label: string, list: string[]) => {
    if (list.length === 0) return;
    const shown = list.slice(0, max).join(", ");
    parts.push(`${list.length} ${label} (${shown}${list.length > max ? ", …" : ""})`);
  };
  fmt("changed since signing", p.modified);
  fmt("missing", p.missing);
  fmt("not covered by the signature", p.extra);
  return parts.join("; ");
}
