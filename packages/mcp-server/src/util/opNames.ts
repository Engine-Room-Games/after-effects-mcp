/**
 * The name to show a reader for an op (issue #243 review).
 *
 * Since #243 every screenshot, `run_jsx`, house-style call and long batch
 * reaches After Effects under an internal op (`_screenshot_frame`, `_run_jsx`,
 * `_project_path`, `_continue_job`, …). Those names are the server's own
 * plumbing: an agent never called them, and a message saying a call is
 * "waiting behind another session's `_run_jsx`" names nothing it can act on.
 * Every message that quotes an op — timeouts, dropped connections, the write
 * queue, the front desk — goes through this, so the reader sees the tool.
 *
 * An internal op behind more than one tool names all of them. A name that is
 * not an internal op is returned as it came. `tests/unit/op-names.mjs`
 * requires every op in `InternalOpMutation` to have an entry here.
 */
export const INTERNAL_OP_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  _continue_job: "run_batch",
  _get_job: "run_batch",
  _render_prepare: "render_queue",
  _render_save: "render_queue",
  _render_mark_done: "render_queue",
  _comp_fingerprint: "snapshot_comp/diff_comp",
  _motion_keys: "analyze_motion",
  // Not behind a tool: the poll that keeps subscribed project resources fresh.
  _live_probe: "live-resources poll",
  _project_path: "get_house_style/set_house_style",
  _screenshot_frame: "screenshot_frame",
  _screenshot_layer: "screenshot_layer",
  _export_mogrt: "export_mogrt",
  _run_jsx: "run_jsx",
});

export function displayOp(op: string): string {
  return Object.prototype.hasOwnProperty.call(INTERNAL_OP_TOOLS, op) ? INTERNAL_OP_TOOLS[op] : op;
}
