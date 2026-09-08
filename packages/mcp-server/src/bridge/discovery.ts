import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTimeoutError } from "../util/errors.js";

/**
 * The port the panel binds unless told otherwise. On a single machine nothing
 * else uses it, which is what makes "who holds 7777" answerable at all.
 */
export const DEFAULT_PORT = 7777;

/** Where the panel records the port it bound. Written by the panel, read here. */
export function portFilePath(): string {
  return path.join(os.homedir(), ".engineroom-ae-mcp", "port");
}

/** `AE_MCP_PORT`, when set to something usable. An explicit pin, so it wins outright. */
export function pinnedPort(): number | null {
  const envPort = process.env.AE_MCP_PORT;
  if (!envPort) return null;
  const n = parseInt(envPort, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** What the port file says, or null when it is absent or unreadable. */
export function portFilePort(): number | null {
  try {
    const f = portFilePath();
    if (fs.existsSync(f)) {
      const txt = fs.readFileSync(f, "utf8").trim();
      const n = parseInt(txt, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {}
  return null;
}

/**
 * The synchronous first guess: env, then the port file, then the default.
 *
 * This is a guess and nothing more. The port file is written by whichever panel
 * bound *last*, and a panel that walked to 7780 and then died leaves 7780 in
 * the file while the panel that is actually answering sits on 7777 (issue #92).
 * The socket is the authority; `locatePanel` is what consults it.
 */
export function discoverPort(): number {
  return pinnedPort() ?? portFilePort() ?? DEFAULT_PORT;
}

/**
 * The ports worth asking, in order.
 *
 * With `AE_MCP_PORT` set the list is that port alone: a pin is an instruction,
 * and a server told which port to use must not wander off it to whatever else
 * happens to answer — that is how a second After Effects instance is addressed
 * deliberately. Otherwise the default comes *before* the port file, because
 * the default is where the panel binds unless something is wrong, and the port
 * file is the thing that was wrong.
 */
export function portCandidates(): number[] {
  const pinned = pinnedPort();
  if (pinned !== null) return [pinned];
  const out = [DEFAULT_PORT];
  const fromFile = portFilePort();
  if (fromFile !== null && fromFile !== DEFAULT_PORT) out.push(fromFile);
  return out;
}

/**
 * Every port worth *asking* when diagnosing, pinned one first: the pin decides
 * where ops go and must never be walked past, but it must not stop
 * `check_setup` from noticing the panel answering on 7777 or on the port the
 * file names — a pinned wrong port would otherwise report "nothing is
 * listening" and send the user to restart After Effects for a panel that is
 * fine (recipe 43). Unpinned, this is `portCandidates()` unchanged.
 */
export function diagnosticPortCandidates(): number[] {
  const out = [...portCandidates()];
  for (const p of [DEFAULT_PORT, portFilePort()]) {
    if (p !== null && !out.includes(p)) out.push(p);
  }
  return out;
}

/** What the panel's /health answers with. `bundleHash` is absent on panels older than 0.3. */
export interface PanelHealth {
  ok: boolean;
  port: number;
  bundleLoaded?: boolean;
  bundleHash?: string | null;
  ts?: number;
}

/**
 * Is this body the AE MCP panel's own /health shape?
 *
 * Anything listening on a candidate port is asked this before being believed.
 * The two keys are the panel's: `ok` is what every version has answered with,
 * and `bundleHash` (or `bundleLoaded`, on panels from before the hash existed)
 * is what nothing else on a loopback port would happen to say. The same test
 * is made in the panel itself when it finds its port held (`isOurHealth` in
 * `client/main.js`); keep the two in step.
 */
export function isPanelHealth(body: unknown): body is PanelHealth {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return b.ok === true && ("bundleHash" in b || "bundleLoaded" in b);
}

/** Short: this is a "who is there" question, asked once per candidate. */
export const PROBE_TIMEOUT_MS = 2000;

export type ProbeStatus =
  /** Answered with the panel's health shape. */
  | "panel"
  /** Accepted the connection and did not answer in time: something is listening, and it is busy. */
  | "busy"
  /** Answered, but not as the panel — some other process holds the port. */
  | "other"
  /** Refused or unreachable: nothing is listening. */
  | "none";

export interface ProbeResult {
  port: number;
  status: ProbeStatus;
  health?: PanelHealth;
  /** One clause, suitable for quoting inside a sentence. */
  detail: string;
}

/**
 * Ask one port whether the panel is there. Never throws: every outcome is a
 * classification, because the caller's next move depends on which one it is.
 */
export async function probePanel(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { port, status: "other", detail: `port ${port} answered HTTP ${res.status}, which is not the panel` };
    }
    const body: unknown = await res.json().catch(() => null);
    if (isPanelHealth(body)) {
      return { port, status: "panel", health: body, detail: `the panel is answering on port ${port}` };
    }
    return { port, status: "other", detail: `port ${port} answered, but not as the After Effects panel` };
  } catch (e) {
    if (isTimeoutError(e)) {
      return {
        port,
        status: "busy",
        detail: `port ${port} accepted the connection but had not answered after ${Math.round(timeoutMs / 1000)}s — a panel may be there and busy`,
      };
    }
    return { port, status: "none", detail: `nothing is listening on port ${port} (${(e as Error).message})` };
  }
}

export interface LocateResult {
  /** The first candidate that answered as the panel, or null. */
  found: ProbeResult | null;
  /** Every candidate asked, in the order asked. */
  probed: ProbeResult[];
}

/**
 * Find the panel among the candidate ports. Probed in order, stopping at the
 * first one that answers as the panel; the rest of the list is still reported
 * so a caller can say what it looked at.
 */
export async function locatePanel(candidates: number[] = portCandidates()): Promise<LocateResult> {
  const probed: ProbeResult[] = [];
  for (const port of candidates) {
    const r = await probePanel(port);
    probed.push(r);
    if (r.status === "panel") return { found: r, probed };
  }
  return { found: null, probed };
}
