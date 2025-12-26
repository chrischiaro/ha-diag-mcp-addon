import WebSocket from "ws";

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;

const HA_BASE_URL = process.env.HA_BASE_URL; // http://<HA-IP>:8123
const HA_TOKEN = process.env.HA_TOKEN;       // long-lived token

function supervisorHeaders() {
  if (!SUPERVISOR_TOKEN) throw new Error("SUPERVISOR_TOKEN missing");
  return { Authorization: `Bearer ${SUPERVISOR_TOKEN}`, "Content-Type": "application/json" };
}

function haDirectHeaders() {
  if (!HA_BASE_URL || !HA_TOKEN) {
    throw new Error("Set HA_BASE_URL and HA_TOKEN for local mode.");
  }
  return { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" };
}

function supervisorMode() {
  return !!SUPERVISOR_TOKEN;
}

export function sanitizeAutomationConfig(cfg: any) {
  if (!cfg || typeof cfg !== "object") return cfg;

  const redactKeys = new Set([
    "access_token",
    "token",
    "password",
    "api_key",
    "webhook_id",
    "url",
    "uri",
    "headers",
    "payload",
    "data",
  ]);

  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) {
        if (redactKeys.has(k)) out[k] = "[REDACTED]";
        else out[k] = walk(val);
      }
      return out;
    }
    return v;
  };

  // Only keep editor-relevant parts, sanitized
  return {
    id: cfg.id ?? null,
    alias: cfg.alias ?? cfg.name ?? null,
    description: cfg.description ?? null,

    mode: cfg.mode ?? null,
    max: cfg.max ?? null,
    max_exceeded: cfg.max_exceeded ?? null,

    trigger: walk(cfg.trigger ?? []),
    condition: walk(cfg.condition ?? []),
    action: walk(cfg.action ?? []),
  };
}

export async function haGet(path: string) {
  const url = supervisorMode()
    ? `http://supervisor/core/api${path}`
    : `${HA_BASE_URL}/api${path}`;

  const headers = supervisorMode() ? supervisorHeaders() : haDirectHeaders();

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HA GET ${path} failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
  return res.json();
}

export async function haState(entityId: string) {
  return haGet(`/states/${encodeURIComponent(entityId)}`);
}

export async function haStates() {
  return haGet("/states");
}

export async function haServices() {
  return haGet("/services");
}

export async function supervisorHostInfo() {
  if (!supervisorMode()) throw new Error("Supervisor API only available in Supervisor mode.");
  const res = await fetch("http://supervisor/host/info", { headers: supervisorHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supervisor host info failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
  return res.json();
}

export function automationItemId(entityId: string) {
  return entityId.startsWith("automation.") ? entityId.slice("automation.".length) : entityId;
}

export async function haAutomationTraces(entityId: string) {
  const itemId = automationItemId(entityId);
  return haGet(`/trace/automation/${encodeURIComponent(itemId)}`);
}

export async function haHistoryPeriod(params: {
  startIso: string;
  endIso?: string;
  entityIds?: string[];
}) {
  const { startIso, endIso, entityIds } = params;
  const qs = new URLSearchParams();
  if (endIso) qs.set("end_time", endIso);
  if (entityIds?.length) qs.set("filter_entity_id", entityIds.join(","));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return haGet(`/history/period/${encodeURIComponent(startIso)}${suffix}`);
}

export async function haLogbook(params: {
  startIso: string;
  endIso?: string;
  entityId?: string;
}) {
  const qs = new URLSearchParams();
  if (params.endIso) qs.set("end_time", params.endIso);
  if (params.entityId) qs.set("entity", params.entityId);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return haGet(`/logbook/${encodeURIComponent(params.startIso)}${suffix}`);
}

export async function haAutomationConfig(entityId: string) {
  // Prefer the internal UI automation id if available
  let internalId: string | null = null;
  try {
    const s: any = await haState(entityId);
    internalId = s?.attributes?.id ? String(s.attributes.id) : null;
  } catch {
    // ignore; we'll fall back
  }

  const itemId =
    internalId ??
    (entityId.startsWith("automation.") ? entityId.slice("automation.".length) : entityId);

  return haGet(`/config/automation/config/${encodeURIComponent(itemId)}`);
}

/* WebSocket to HA */
function wsUrl() {
  // Prefer supervisor proxy when running as add-on
  if (supervisorMode()) return "ws://supervisor/core/api/websocket";

  if (!HA_BASE_URL) throw new Error("HA_BASE_URL missing for local mode.");
  return HA_BASE_URL.replace(/^http/, "ws") + "/api/websocket";
}

function wsAuthToken() {
  // Prefer explicit HA token; fall back to supervisor token in add-on mode
  if (HA_TOKEN) return HA_TOKEN;
  if (SUPERVISOR_TOKEN) return SUPERVISOR_TOKEN;
  throw new Error("Need HA_TOKEN or SUPERVISOR_TOKEN to auth WebSocket.");
}

// Minimal WS command helper (connect → auth → send → await result)
async function haWsCommand<T = any>(payload: Record<string, any>): Promise<T> {
  const url = wsUrl();
  const token = wsAuthToken();

  return await new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(url);
    let msgId = 1;
    const id = ++msgId;

    const cleanup = (err?: any) => {
      try { ws.close(); } catch { }
      if (err) reject(err);
    };

    ws.on("open", () => {
      // 1) auth
      ws.send(JSON.stringify({ type: "auth", access_token: token }));
      // 2) command
      ws.send(JSON.stringify({ id, ...payload }));
    });

    ws.on("message", (buf: Buffer) => {
      let msg: Record<string, any>;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      // auth ok/fail
      if (msg?.type === "auth_invalid") return cleanup(new Error("WS auth_invalid"));
      if (msg?.type === "auth_ok") return;

      // command result
      if (msg?.id === id) {
      if (msg?.success) resolve(msg.result as T);
      else cleanup(new Error(msg?.error?.message ?? "WS command failed"));
      }
    });

    ws.on("error", cleanup);
    ws.on("close", () => cleanup(new Error("WebSocket closed before result")));
  });
}

export async function haRepairsListIssues() {
  // This is the “Repairs” list in Settings
  return haWsCommand<{ issues: any[] }>({ type: "repairs/list_issues" });
}

/* Helper functions */
export function toIsoFromMillis(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
