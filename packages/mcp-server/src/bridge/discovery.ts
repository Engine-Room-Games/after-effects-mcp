import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT = 7777;

export function discoverPort(): number {
  const envPort = process.env.AE_MCP_PORT;
  if (envPort) {
    const n = parseInt(envPort, 10);
    if (Number.isFinite(n)) return n;
  }
  try {
    const f = path.join(os.homedir(), ".engineroom-ae-mcp", "port");
    if (fs.existsSync(f)) {
      const txt = fs.readFileSync(f, "utf8").trim();
      const n = parseInt(txt, 10);
      if (Number.isFinite(n)) return n;
    }
  } catch {}
  return DEFAULT_PORT;
}
