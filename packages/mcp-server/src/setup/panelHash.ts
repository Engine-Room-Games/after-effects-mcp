import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The hash that names the panel's own code (issue #243) — every shipped file of
 * the panel except `jsx/bundle.jsx`, which `bundleHash` covers.
 *
 * A port of `packages/ae-panel/client/panelhash.js`, which the running panel
 * computes over its own folder at startup and reports on `/health` as
 * `clientHash`. This one is computed over the panel the server ships and over
 * the installed copy. `tests/unit/panel-hash.mjs` holds the two to each other;
 * change both together. The reasoning for each exclusion is in the panel's
 * copy. In short: bundle.jsx (own hash), node_modules and .DS_Store anywhere,
 * the signature files a self-signed install adds (`META-INF/`, `mimetype` —
 * a signed install is a current install), the root package.json (a version
 * stamp), and the two version attributes of `CSXS/manifest.xml`.
 */

const SKIP_ANY_DEPTH = new Set(["node_modules", ".DS_Store"]);
const SKIP_AT_ROOT = new Set(["META-INF", "mimetype", "package.json"]);
const SKIP_PATHS = new Set(["jsx/bundle.jsx"]);
const MANIFEST = "CSXS/manifest.xml";

function listFiles(dir: string, prefix: string, out: string[]): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_ANY_DEPTH.has(name)) continue;
    if (!prefix && SKIP_AT_ROOT.has(name)) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (SKIP_PATHS.has(rel)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) listFiles(full, rel, out);
    else out.push(rel);
  }
  return out;
}

function normalise(rel: string, bytes: Buffer): Buffer {
  if (rel !== MANIFEST) return bytes;
  const text = bytes
    .toString("utf8")
    .replace(/(ExtensionBundleVersion=")[^"]*(")/g, "$1$2")
    .replace(/(<Extension\s+Id="[^"]*"\s+Version=")[^"]*(")/g, "$1$2");
  return Buffer.from(text, "utf8");
}

/** sha256 over the panel's files, or null when the folder cannot be read. */
export function panelClientHash(dir: string): string | null {
  try {
    const files = listFiles(dir, "", []).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const h = crypto.createHash("sha256");
    for (const rel of files) {
      const bytes = normalise(rel, fs.readFileSync(path.join(dir, rel)));
      h.update(`${rel}\u0000${crypto.createHash("sha256").update(bytes).digest("hex")}\n`);
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}
