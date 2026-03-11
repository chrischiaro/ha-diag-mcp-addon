import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { registerTools } from "./mcpTools.js";

const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

/************************/
/** Helper Functions */
/************************/
function log(...args: any[]) {
  if (["trace", "debug", "info"].includes(LOG_LEVEL)) console.log(...args);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: ALLOW_ORIGIN }));
app.use((err: any, _req: any, _res: any, _next: any) => {
  console.error("express error:", err);
});
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

/************************/
/** YAML helper funcs (add-on only) */
/************************/
async function fileExists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// Find YAML files we care about (automations.yaml + packages/*.yaml)
async function listAutomationYamlFiles(): Promise<string[]> {
  const files: string[] = [];
  const automations = "/config/automations.yaml";
  if (await fileExists(automations)) files.push(automations);

  const packagesDir = "/config/packages";
  if (await fileExists(packagesDir)) {
    const lvl1 = await fs.readdir(packagesDir).catch(() => []);
    for (const name of lvl1) {
      const p = path.join(packagesDir, name);
      const st = await fs.stat(p).catch(() => null);
      if (!st) continue;

      if (st.isFile() && (name.endsWith(".yaml") || name.endsWith(".yml"))) files.push(p);

      if (st.isDirectory()) {
        const lvl2 = await fs.readdir(p).catch(() => []);
        for (const n2 of lvl2) {
          if (n2.endsWith(".yaml") || n2.endsWith(".yml")) files.push(path.join(p, n2));
        }
      }
    }
  }

  return files;
}

function slugifyLikeHA(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
}

function extractAutomationLists(doc: any): any[] {
  if (Array.isArray(doc)) return doc;
  const a = doc?.automation;
  if (Array.isArray(a)) return a;
  return [];
}

async function findAutomationInYaml(itemId: string) {
  const files = await listAutomationYamlFiles();

  for (const file of files) {
    const text = await fs.readFile(file, "utf-8");
    const doc = yaml.load(text);

    const autos = extractAutomationLists(doc);
    for (let i = 0; i < autos.length; i++) {
      const a = autos[i];
      const id = typeof a?.id === "string" ? a.id : null;
      const alias = typeof a?.alias === "string" ? a.alias : null;

      if (id && id === itemId) {
        return { file, index: i, match: "id", automation: a };
      }
      if (alias && slugifyLikeHA(alias) === itemId) {
        return { file, index: i, match: "alias_slug", automation: a };
      }
    }
  }

  return null;
}

/************************/
/** Express HTTP MCP Server */
/************************/
const transports: Record<string, StreamableHTTPServerTransport> = {};

function requireTransport(req: express.Request, res: express.Response) {
  const sessionId = req.header("mcp-session-id") ?? undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Missing or invalid mcp-session-id");
    return null;
  }
  return transports[sessionId];
}

async function getOrCreateTransport(req: express.Request, res: express.Response) {
  const sessionId = req.header("mcp-session-id") ?? undefined;

  if (sessionId && transports[sessionId]) return transports[sessionId];

  if (!sessionId && isInitializeRequest(req.body)) {
    // Create a new McpServer instance for each session
    const mcp = new McpServer({
      name: "home-automation-diagnostics",
      version: "0.1.0",
    });
    registerTools(mcp);

    let transport: StreamableHTTPServerTransport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports[newSessionId] = transport;
        log("MCP session initialized:", newSessionId);
      },
    });

    transport.onclose = () => {
      const id = transport?.sessionId;
      if (id && transports[id]) delete transports[id];
      log("MCP session closed:", id);
    };

    await mcp.connect(transport);
    return transport;
  }

  res.status(400).json({ error: "Bad Request: missing session or not an initialize request" });
  return null;
}

app.get("/", (_req, res) => res.status(200).json({ ok: true, message: "Home Automation Diagnostics MCP is running." }));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.post("/mcp", async (req, res) => {
  const t = await getOrCreateTransport(req, res);
  if (!t) return;
  await t.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const t = requireTransport(req, res);
  if (!t) return;
  await t.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const t = requireTransport(req, res);
  if (!t) return;
  await t.handleRequest(req, res);
});

app.get("/health", (_req, res) => res.json({ ok: true }));

/************************/
/** YAML endpoint (add-on) */
/************************/
app.get("/yaml/automation/:itemId", async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const found = await findAutomationInYaml(itemId);
    if (!found) {
      res.status(404).json({ error: "Not found in YAML", itemId });
      return;
    }
    res.json(found);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

/************************/
/** Filesystem endpoints (add-on) */
/************************/
app.post("/fs/read", async (req, res) => {
  try {
    const { path: filePath, max_size } = req.body;
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ error: "Missing or invalid 'path' parameter" });
      return;
    }

    // Security: restrict to /config directory
    const normalized = path.normalize(filePath);
    if (!normalized.startsWith("/config/") && normalized !== "/config") {
      res.status(403).json({ error: "Access denied: path must be within /config/" });
      return;
    }

    const stat = await fs.stat(normalized);
    if (!stat.isFile()) {
      res.status(400).json({ error: "Path is not a file" });
      return;
    }

    const maxSize = max_size || 100000; // 100KB default
    if (stat.size > maxSize) {
      res.status(413).json({
        error: `File too large (${stat.size} bytes, max ${maxSize})`,
        truncated: true,
      });
      return;
    }

    const content = await fs.readFile(normalized, "utf-8");
    res.json({ path: normalized, size: stat.size, content });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/fs/find", async (req, res) => {
  try {
    const { filename, search_root } = req.body;
    if (!filename || typeof filename !== "string") {
      res.status(400).json({ error: "Missing or invalid 'filename' parameter" });
      return;
    }

    const root = search_root || "/config";
    const normalized = path.normalize(root);
    if (!normalized.startsWith("/config/") && normalized !== "/config") {
      res.status(403).json({ error: "Access denied: search_root must be within /config/" });
      return;
    }

    const results: string[] = [];
    const maxResults = 50;

    async function search(dir: string, depth: number) {
      if (depth > 5 || results.length >= maxResults) return;

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = path.join(dir, entry.name);

        if (entry.isFile() && entry.name.includes(filename)) {
          results.push(fullPath);
        }

        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          await search(fullPath, depth + 1);
        }
      }
    }

    await search(normalized, 0);
    res.json({ filename, search_root: normalized, count: results.length, results });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/fs/grep", async (req, res) => {
  try {
    const { path: filePath, pattern, context_lines } = req.body;
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ error: "Missing or invalid 'path' parameter" });
      return;
    }
    if (!pattern || typeof pattern !== "string") {
      res.status(400).json({ error: "Missing or invalid 'pattern' parameter" });
      return;
    }

    // Security: restrict to /config directory
    const normalized = path.normalize(filePath);
    if (!normalized.startsWith("/config/") && normalized !== "/config") {
      res.status(403).json({ error: "Access denied: path must be within /config/" });
      return;
    }

    const content = await fs.readFile(normalized, "utf-8");
    const lines = content.split("\n");
    const contextSize = context_lines || 5;
    const matches: any[] = [];

    const regex = new RegExp(pattern, "i");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const start = Math.max(0, i - contextSize);
        const end = Math.min(lines.length - 1, i + contextSize);
        const contextLines = [];

        for (let j = start; j <= end; j++) {
          contextLines.push({
            line_number: j + 1,
            content: lines[j],
            is_match: j === i,
          });
        }

        matches.push({
          line_number: i + 1,
          line: lines[i],
          context: contextLines,
        });

        if (matches.length >= 20) break; // Limit results
      }
    }

    res.json({
      path: normalized,
      pattern,
      count: matches.length,
      matches,
      truncated: matches.length >= 20,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/fs/write", async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ error: "Missing or invalid 'path' parameter" });
      return;
    }
    if (typeof content !== "string") {
      res.status(400).json({ error: "Missing or invalid 'content' parameter" });
      return;
    }

    // Security: restrict to /config directory
    const normalized = path.normalize(filePath);
    if (!normalized.startsWith("/config/") && normalized !== "/config") {
      res.status(403).json({ error: "Access denied: path must be within /config/" });
      return;
    }

    // Additional safety: don't allow writing to /config itself (it's a directory)
    if (normalized === "/config") {
      res.status(400).json({ error: "Cannot write to /config directory itself" });
      return;
    }

    // Write the file
    await fs.writeFile(normalized, content, "utf-8");
    const stat = await fs.stat(normalized);

    res.json({
      path: normalized,
      size: stat.size,
      success: true,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.listen(PORT, () => {
  console.log(`Home Automation Diagnostics MCP listening on :${PORT} (endpoint /mcp)`);
});