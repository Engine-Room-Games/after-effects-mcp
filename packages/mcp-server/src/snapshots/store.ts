/**
 * The comp fingerprints `snapshot_comp` takes, held in this server's memory.
 *
 * They are deliberately not written into the After Effects project. A snapshot
 * is scaffolding for one session's verification — it answers "what did my last
 * write actually do" — and putting it in the .aep would mean a tool that
 * *reads* the project modifies it, showing up in the user's undo stack and in
 * their file, for a value nobody wants to keep. The panel gathers the
 * fingerprint because only the panel can talk to AE; the server keeps it
 * because only the server has anywhere to keep it that costs the project
 * nothing.
 *
 * The consequence is that snapshots live exactly as long as the server process,
 * which for a stdio MCP client is the session. That is acceptable — nothing
 * needs a snapshot from yesterday — but it must never be discovered as a
 * cryptic failure, so `missingMessage` says it in full and names the way
 * forward.
 */

export interface CompFingerprint {
  compId: number;
  name: string;
  numLayers: number;
  layers: unknown[];
  [key: string]: unknown;
}

export interface StoredSnapshot {
  id: string;
  compId: number;
  compName: string;
  layerCount: number;
  takenAt: number;
  fingerprint: CompFingerprint;
}

/** Enough for any realistic verify-as-you-go session; small enough to be free. */
const DEFAULT_MAX = 32;

export class SnapshotStore {
  private snapshots = new Map<string, StoredSnapshot>();
  private seq = 0;

  constructor(private readonly max: number = DEFAULT_MAX) {}

  store(fingerprint: CompFingerprint): StoredSnapshot {
    this.seq += 1;
    const snapshot: StoredSnapshot = {
      id: `snap_${this.seq}`,
      compId: fingerprint.compId,
      compName: fingerprint.name,
      layerCount: Array.isArray(fingerprint.layers) ? fingerprint.layers.length : 0,
      takenAt: Date.now(),
      fingerprint,
    };
    this.snapshots.set(snapshot.id, snapshot);
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.snapshots.size > this.max) {
      const oldest = this.snapshots.keys().next();
      if (oldest.done) break;
      this.snapshots.delete(oldest.value);
    }
    return snapshot;
  }

  get(id: string): StoredSnapshot | undefined {
    return this.snapshots.get(id);
  }

  size(): number {
    return this.snapshots.size;
  }

  ids(): string[] {
    return [...this.snapshots.keys()];
  }

  /**
   * Why an id is not here, and what to do instead. An agent hitting this has
   * already done the work it wanted to verify, so "unknown snapshot" on its own
   * would strand it.
   */
  missingMessage(id: string): string {
    const held = this.ids();
    const listing =
      held.length === 0
        ? "No snapshots are held in this session yet."
        : `Held right now: ${held.join(", ")}.`;
    return (
      `No snapshot "${id}". Snapshots live in this server's memory for the length of the session: ` +
      `they are gone when the MCP server restarts, and the oldest is dropped once ${this.max} are held. ` +
      `${listing} Take a fresh one with snapshot_comp, do the work, then diff against that id. ` +
      `To verify a write you have already made, read the comp back with list_layers instead — ` +
      `a diff can only compare against a snapshot taken beforehand.`
    );
  }
}
