import WebSocket from "ws";
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_BASE_URL = process.env.HA_BASE_URL; // http://<HA-IP>:8123
const HA_TOKEN = process.env.HA_TOKEN; // long-lived token
function supervisorHeaders() {
    if (!SUPERVISOR_TOKEN)
        throw new Error("SUPERVISOR_TOKEN missing");
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
export function sanitizeAutomationConfig(cfg) {
    if (!cfg || typeof cfg !== "object")
        return cfg;
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
    const walk = (v) => {
        if (Array.isArray(v))
            return v.map(walk);
        if (v && typeof v === "object") {
            const out = {};
            for (const [k, val] of Object.entries(v)) {
                if (redactKeys.has(k))
                    out[k] = "[REDACTED]";
                else
                    out[k] = walk(val);
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
export async function haGet(path) {
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
// For endpoints that return plain text (e.g. /error_log); haGet always parses JSON.
export async function haGetText(path) {
    const url = supervisorMode()
        ? `http://supervisor/core/api${path}`
        : `${HA_BASE_URL}/api${path}`;
    const headers = supervisorMode() ? supervisorHeaders() : haDirectHeaders();
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HA GET ${path} failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
    }
    return res.text();
}
// Current-run Core log only (HA does not keep the previous boot's log here).
export async function haErrorLog() {
    return haGetText("/error_log");
}
export async function haPost(path, body) {
    const url = supervisorMode()
        ? `http://supervisor/core/api${path}`
        : `${HA_BASE_URL}/api${path}`;
    const headers = supervisorMode() ? supervisorHeaders() : haDirectHeaders();
    const res = await fetch(url, {
        method: "POST",
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HA POST ${path} failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
    }
    const contentType = res.headers.get("content-type");
    if (contentType?.includes("application/json")) {
        return res.json();
    }
    return res.text();
}
export async function haState(entityId) {
    return haGet(`/states/${encodeURIComponent(entityId)}`);
}
export async function haStates() {
    return haGet("/states");
}
export async function haServices() {
    return haGet("/services");
}
export async function supervisorHostInfo() {
    if (!supervisorMode())
        throw new Error("Supervisor API only available in Supervisor mode.");
    const res = await fetch("http://supervisor/host/info", { headers: supervisorHeaders() });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supervisor host info failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
    }
    return res.json();
}
export function automationItemId(entityId) {
    return entityId.startsWith("automation.") ? entityId.slice("automation.".length) : entityId;
}
// Traces are only exposed over the HA websocket API (trace/list, trace/get); there is no REST route.
// Traces are keyed by the automation's config id (state attribute "id"), not by the entity_id.
export async function haAutomationTraces(entityId, opts) {
    let itemId = automationItemId(entityId);
    let hasId = false;
    try {
        const s = await haState(entityId);
        if (s?.attributes?.id) {
            itemId = String(s.attributes.id);
            hasId = true;
        }
    }
    catch {
        // fall back to the entity object id
    }
    const traces = await haWsCommand({ type: "trace/list", domain: "automation", item_id: itemId });
    const list = Array.isArray(traces) ? traces : [];
    let latest = null;
    if (opts?.includeLatestFull && list.length) {
        const newest = [...list].sort((a, b) => (Date.parse(b?.timestamp?.start ?? "") || 0) - (Date.parse(a?.timestamp?.start ?? "") || 0))[0];
        latest = await haWsCommand({ type: "trace/get", domain: "automation", item_id: itemId, run_id: newest.run_id });
    }
    let note;
    if (!list.length) {
        note = hasId
            ? "No stored traces for this automation id (it may not have run recently, or traces were cleared)."
            : "The automation has no 'id' attribute (typical for YAML automations without an id), so traces could not be matched reliably; the entity object id was tried instead.";
    }
    return { item_id: itemId, traces: list, latest_full: latest, note };
}
export async function haHistoryPeriod(params) {
    const { startIso, endIso, entityIds, minimalResponse, noAttributes, significantChangesOnly } = params;
    const qs = new URLSearchParams();
    if (endIso)
        qs.set("end_time", endIso);
    if (entityIds?.length)
        qs.set("filter_entity_id", entityIds.join(","));
    // HA treats these as flags (presence = on); significant_changes_only defaults to on, "0" turns it off
    if (minimalResponse)
        qs.set("minimal_response", "");
    if (noAttributes)
        qs.set("no_attributes", "");
    if (significantChangesOnly === false)
        qs.set("significant_changes_only", "0");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return haGet(`/history/period/${encodeURIComponent(startIso)}${suffix}`);
}
export async function haLogbook(params) {
    const qs = new URLSearchParams();
    if (params.endIso)
        qs.set("end_time", params.endIso);
    if (params.entityId)
        qs.set("entity", params.entityId);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return haGet(`/logbook/${encodeURIComponent(params.startIso)}${suffix}`);
}
export async function haAutomationConfig(entityId) {
    // Prefer the internal UI automation id if available
    let internalId = null;
    try {
        const s = await haState(entityId);
        internalId = s?.attributes?.id ? String(s.attributes.id) : null;
    }
    catch {
        // ignore; we'll fall back
    }
    const itemId = internalId ??
        (entityId.startsWith("automation.") ? entityId.slice("automation.".length) : entityId);
    return haGet(`/config/automation/config/${encodeURIComponent(itemId)}`);
}
/* WebSocket to HA */
function wsUrl() {
    // Prefer supervisor proxy when running as add-on
    if (supervisorMode())
        return "ws://supervisor/core/api/websocket";
    if (!HA_BASE_URL)
        throw new Error("HA_BASE_URL missing for local mode.");
    return HA_BASE_URL.replace(/^http/, "ws") + "/api/websocket";
}
function wsAuthToken() {
    // Prefer explicit HA token; fall back to supervisor token in add-on mode
    if (HA_TOKEN)
        return HA_TOKEN;
    if (SUPERVISOR_TOKEN)
        return SUPERVISOR_TOKEN;
    throw new Error("Need HA_TOKEN or SUPERVISOR_TOKEN to auth WebSocket.");
}
// Minimal WS command helper: connect → auth_required → auth → auth_ok → send command → await result.
// Closes the socket once settled and gives up after timeoutMs.
async function haWsCommand(payload, timeoutMs = 15000) {
    const url = wsUrl();
    const token = wsAuthToken();
    return await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const id = 1;
        let settled = false;
        const finish = (err, result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                ws.close();
            }
            catch { }
            if (err)
                reject(err);
            else
                resolve(result);
        };
        const timer = setTimeout(() => finish(new Error(`WebSocket command timed out after ${timeoutMs}ms`)), timeoutMs);
        ws.on("message", (buf) => {
            let msg;
            try {
                msg = JSON.parse(buf.toString());
            }
            catch {
                return;
            }
            if (msg?.type === "auth_required") {
                ws.send(JSON.stringify({ type: "auth", access_token: token }));
                return;
            }
            if (msg?.type === "auth_invalid")
                return finish(new Error("WS auth_invalid"));
            if (msg?.type === "auth_ok") {
                ws.send(JSON.stringify({ id, ...payload }));
                return;
            }
            // command result
            if (msg?.type === "result" && msg?.id === id) {
                if (msg?.success)
                    finish(undefined, msg.result);
                else
                    finish(new Error(msg?.error?.message ?? "WS command failed"));
            }
        });
        ws.on("error", (e) => finish(e));
        ws.on("close", () => finish(new Error("WebSocket closed before result")));
    });
}
export async function haRepairsListIssues() {
    return haWsCommand({ type: "repairs/list_issues" });
}
export async function haCallService(domain, service, serviceData, target) {
    // The REST API takes service data as the flat request body; entity_id / device_id / area_id
    // sit alongside it. Wrapping them in { service_data, target } makes HA reject the call (400).
    const body = { ...(serviceData ?? {}), ...(target ?? {}) };
    return haPost(`/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, body);
}
export async function haRenderTemplate(template) {
    return haPost("/template", { template });
}
/* Helper functions */
export function toIsoFromMillis(epochMs) {
    return new Date(epochMs).toISOString();
}
