/**
 * What the running panel says it supports (issue #220, stage 3).
 *
 * `bundleHash` on `/health` names the ExtendScript the panel is running. It
 * says nothing about the panel's own JavaScript (`client/main.js`), and a
 * bundle can be current while that is not. From stage 3 on the panel lists
 * `capabilities` on `/health`, and that list is the only word on which panel
 * code is answering.
 *
 * **A panel that lists nothing is "legacy", never "broken".** Every panel
 * before stage 3 omits the field, and it must keep working exactly as before:
 * the server uses a capability only when it is listed, and takes the path
 * every panel has otherwise. A malformed field counts as absent, for the same
 * reason — guessing that a panel can do something is how a call fails.
 */

/** `_project_path` answers the .aep's path cheaply; the server does house-style I/O itself. */
export const CAP_PROJECT_PATH = "project-path";

/**
 * `_screenshot_frame`, `_screenshot_layer` and `_export_mogrt` answer with file
 * paths; the server waits for, normalises, tiles and patches the images itself
 * (issue #220, stage 4; frames/pipeline.ts).
 */
export const CAP_SERVER_IMAGES = "server-images";

export interface PanelCapabilities {
  /** True when the panel sent no usable `capabilities` field. */
  legacy: boolean;
  has(name: string): boolean;
  /** For logs and diagnostics. Empty when legacy. */
  list: readonly string[];
}

export const LEGACY_CAPABILITIES: PanelCapabilities = Object.freeze({
  legacy: true,
  has: () => false,
  list: Object.freeze([]) as readonly string[],
});

/** Read `capabilities` off a `/health` body. Anything but an array of strings is legacy. */
export function panelCapabilities(health: unknown): PanelCapabilities {
  const raw = health && typeof health === "object" ? (health as { capabilities?: unknown }).capabilities : undefined;
  if (!Array.isArray(raw)) return LEGACY_CAPABILITIES;
  const list = Object.freeze(raw.filter((c): c is string => typeof c === "string"));
  const set = new Set(list);
  return Object.freeze({ legacy: false, has: (name: string) => set.has(name), list });
}
