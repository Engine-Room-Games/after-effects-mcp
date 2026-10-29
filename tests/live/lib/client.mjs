// A minimal MCP client over stdio, written against the wire rather than the SDK
// so what the driver sees is exactly what the server sent — order of progress
// notifications included (recipe 7 is a question about order).
//
// It spawns ONE child, the server from this checkout, and only ever kills that
// child. It never talks to After Effects itself: everything goes through the
// server, the way an agent's calls do.

import { spawn } from "node:child_process";
import { encodeMessage, LineDecoder, readToolResult } from "./framing.mjs";

export const PROTOCOL_VERSION = "2025-06-18";

export class StdioMcpClient {
  /**
   * @param {object} o
   * @param {string} o.command   executable (normally process.execPath)
   * @param {string[]} o.args    e.g. [<checkout>/packages/mcp-server/dist/index.js]
   * @param {string} [o.cwd]
   * @param {NodeJS.ProcessEnv} [o.env]
   * @param {number} [o.timeoutMs] default per-request timeout
   */
  constructor({ command, args, cwd, env, timeoutMs = 120_000 }) {
    this.spec = { command, args, cwd, env };
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    /** Every notification, in arrival order, with the ids of requests still open at that moment. */
    this.notifications = [];
    this.noise = [];
    this.stderr = "";
    this.child = null;
    this.exited = null;
  }

  start() {
    const { command, args, cwd, env } = this.spec;
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    // However this process ends — a throw nobody caught, process.exit from a
    // signal handler — the server it started goes with it. `exit` handlers run
    // synchronously, and kill() is synchronous.
    const killOnExit = () => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill("SIGKILL");
        } catch {}
      }
    };
    process.on("exit", killOnExit);
    this.child.once("exit", () => process.removeListener("exit", killOnExit));
    const decoder = new LineDecoder({
      onMessage: (m) => this.#onMessage(m),
      onNoise: (line) => this.noise.push(line),
    });
    this.child.stdout.on("data", (d) => decoder.push(d));
    this.child.stdout.on("end", () => decoder.end());
    this.child.stderr.on("data", (d) => {
      this.stderr += d.toString("utf8");
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-100_000);
    });
    this.exited = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        const err = new Error(
          `MCP server exited (code ${code}, signal ${signal}) with requests outstanding.\n` +
            `Last stderr:\n${this.stderr.slice(-2000)}`
        );
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        resolve({ code, signal });
      });
    });
    this.child.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
    return this;
  }

  #onMessage(m) {
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        const e = new Error(`JSON-RPC error ${m.error.code}: ${m.error.message}`);
        e.rpc = m.error;
        p.reject(e);
      } else p.resolve(m.result);
      return;
    }
    if (m.method !== undefined && m.id !== undefined) {
      // A request from the server. We advertise no capabilities, so the only
      // one worth answering is ping; anything else is refused politely.
      if (m.method === "ping") this.#write({ jsonrpc: "2.0", id: m.id, result: {} });
      else this.#write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      return;
    }
    if (m.method !== undefined) {
      this.notifications.push({ ...m, openRequests: [...this.pending.keys()] });
    }
  }

  #write(msg) {
    if (!this.child || this.child.exitCode !== null) throw new Error("MCP server is not running");
    this.child.stdin.write(encodeMessage(msg));
  }

  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ae-mcp-live-driver", version: "1" },
    });
    this.notify("notifications/initialized");
    this.serverInfo = result;
    return result;
  }

  async listTools() {
    const r = await this.request("tools/list", {});
    return r.tools;
  }

  /** Calls a tool; never throws for a tool-level error (that is a result to assert on). */
  async callTool(name, args = {}, { timeoutMs, progressToken } = {}) {
    const params = { name, arguments: args };
    if (progressToken !== undefined) params._meta = { progressToken };
    const raw = await this.request("tools/call", params, { timeoutMs });
    return readToolResult(raw);
  }

  /** Ends the child this client started — and nothing else. */
  async close() {
    if (!this.child || this.child.exitCode !== null) return;
    try {
      this.child.stdin.end();
    } catch {}
    const done = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (done === null && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      const termed = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r(null), 2000))]);
      if (termed === null && this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000))]);
      }
    }
  }
}
