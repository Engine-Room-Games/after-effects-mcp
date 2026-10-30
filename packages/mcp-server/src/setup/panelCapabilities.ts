/**
 * What the running panel says it supports (issue #220, stage 3).
 *
 * Until issue #243 a capability switched the server between two paths: the
 * server's own (screenshots, house-style I/O, `run_jsx` assembly, batch
 * driving) for a panel that listed it, and the panel's older in-panel code for
 * one that did not. Those older paths are gone from both sides. Every panel
 * this server will talk to must do all four, and the version gate
 * (`setup/panelVersion.ts`) refuses one that does not, with the "update your
 * panel" message, before any call is forwarded.
 *
 * The hashes are what normally decide that — a panel whose `bundleHash` and
 * `clientHash` match the shipped panel has these capabilities by construction.
 * The list is what the gate falls back on when the server has no shipped panel
 * to hash (`sourcePanelHashes()` is null): it cannot say the panel is the
 * current one, but it can say whether the panel can do what this server will
 * ask of it. A missing or malformed field means "none".
 */

/** `_project_path` answers the .aep's path cheaply; the server does house-style I/O itself. */
export const CAP_PROJECT_PATH = "project-path";

/**
 * `_screenshot_frame`, `_screenshot_layer` and `_export_mogrt` answer with file
 * paths; the server waits for, normalises, tiles and patches the images itself
 * (issue #220, stage 4; frames/pipeline.ts).
 */
export const CAP_SERVER_IMAGES = "server-images";

/**
 * `_run_jsx` runs a script the server assembled, and a failure comes back
 * with the raw line for the server to map (issue #220, stage 6;
 * tools/runJsxAssembly.ts).
 */
export const CAP_SERVER_RUN_JSX = "server-run-jsx";

/**
 * A chunked `run_batch` answers the envelope with `driver: "server"` and sends
 * no `_continue_job` of its own; the server sends one per chunk (issue #220,
 * stage 5; jobs/batchDriver.ts).
 */
export const CAP_SERVER_DRIVES_JOBS = "server-drives-jobs";

/** Everything this server relies on. A panel missing any of them is out of date. */
export const REQUIRED_PANEL_CAPABILITIES: readonly string[] = Object.freeze([
  CAP_PROJECT_PATH,
  CAP_SERVER_IMAGES,
  CAP_SERVER_RUN_JSX,
  CAP_SERVER_DRIVES_JOBS,
]);

/** Read `capabilities` off a `/health` body. Anything but an array of strings lists nothing. */
export function panelCapabilities(health: unknown): readonly string[] {
  const raw = health && typeof health === "object" ? (health as { capabilities?: unknown }).capabilities : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string");
}

/** The required capabilities a `/health` body does not list, in a stable order. */
export function missingCapabilities(health: unknown): string[] {
  const have = new Set(panelCapabilities(health));
  return REQUIRED_PANEL_CAPABILITIES.filter((c) => !have.has(c));
}
