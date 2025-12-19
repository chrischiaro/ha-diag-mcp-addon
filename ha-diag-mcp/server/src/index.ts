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

const mcp = new McpServer({
  name: "home-automation-diagnostics",
  version: "0.1.0",
});

registerTools(mcp);

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

app.listen(PORT, () => {
  console.log(`Home Automation Diagnostics MCP listening on :${PORT} (endpoint /mcp)`);
});