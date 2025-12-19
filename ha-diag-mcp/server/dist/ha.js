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
export async function haAutomationTraces(entityId) {
    const itemId = automationItemId(entityId);
    return haGet(`/trace/automation/${encodeURIComponent(itemId)}`);
}
export async function haHistoryPeriod(params) {
    const { startIso, endIso, entityIds } = params;
    const qs = new URLSearchParams();
    if (endIso)
        qs.set("end_time", endIso);
    if (entityIds?.length)
        qs.set("filter_entity_id", entityIds.join(","));
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
export function toIsoFromMillis(epochMs) {
    return new Date(epochMs).toISOString();
}
