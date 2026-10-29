/**
 * Keys no tool argument may carry, at any depth, for any op.
 *
 * The server receives args as JSON, where `"__proto__"` is an ordinary own
 * key. It forwards them as JSON too, and ExtendScript parses them back — with
 * its own native `JSON.parse`, or `core.jsx`'s polyfill, which is
 * `eval("(" + text + ")")`. In an object *literal* `__proto__` sets the
 * prototype, and ExtendScript honours `__proto__` as a magic property, so on
 * the panel side such a key can turn into an inherited value that a handler
 * reads as if the caller had passed it. That is how
 * `run_batch{ops:[{op:"run_batch",args:{"__proto__":{ops:[{op:"run_jsx"}]}}}]}`
 * hid a `run_jsx` step from the switch's batch walk, which reads own keys only
 * (issue #135, PR review). Which of the two parsers AE 2026 actually uses, and
 * exactly what it does with the key, has not been measured live — so the key
 * is refused before it can reach either.
 *
 * `constructor` and `prototype` go with it: neither is a name any schema here
 * uses, and both are the other half of every prototype-pollution recipe.
 *
 * **Scope: every op, not just `run_batch`.** zod strips unknown keys from a
 * declared object, but `z.unknown()` and `z.record()` fields pass anything
 * through — `run_batch` steps, `run_jsx`'s `args`, property-value maps — and a
 * changed prototype misleads any handler that reads a field, not only the
 * batch loop. The check is one walk over a payload that is already in memory,
 * and no legitimate call uses these names as keys, so the cost of applying it
 * everywhere is nothing and the cost of choosing ops is remembering to.
 */
export const FORBIDDEN_ARG_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Deeper than any real call nests; `run_batch` eight levels down is about 32. */
export const MAX_ARG_DEPTH = 64;

export interface UnsafeArg {
  path: string;
  problem: string;
}

/** Every forbidden key in `value`, by path; also a refusal if it nests past `MAX_ARG_DEPTH`. */
export function findUnsafeArgKeys(value: unknown): UnsafeArg[] {
  const found: UnsafeArg[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (depth > MAX_ARG_DEPTH) {
      found.push({ path: path || "(args)", problem: `nests more than ${MAX_ARG_DEPTH} levels deep` });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    // Own keys only, and Object.keys reports an own "__proto__" — which is
    // exactly the key JSON.parse produces from the wire.
    for (const k of Object.keys(v)) {
      const at = path ? `${path}.${k}` : k;
      if (FORBIDDEN_ARG_KEYS.has(k)) found.push({ path: at, problem: `the key "${k}" is not allowed` });
      walk((v as Record<string, unknown>)[k], at, depth + 1);
    }
  };
  walk(value, "", 0);
  return found;
}

export function unsafeArgsMessage(tool: string, found: UnsafeArg[]): string {
  return (
    `Invalid arguments for ${tool}: ${found.map((f) => `${f.path} — ${f.problem}`).join("; ")}. ` +
    `Nothing was sent to After Effects. "__proto__", "constructor" and "prototype" are refused as keys ` +
    `anywhere in a tool's arguments; rename the key or drop it.`
  );
}
