import { z } from "zod";
import yaml from "js-yaml";
import { defineTool } from "./toolkit.js";
import { haAutomationConfig, haAutomationTraces, haLogbook, haHistoryPeriod, haRepairsListIssues, haServices, haState, haStates, sanitizeAutomationConfig, supervisorHostInfo, toIsoFromMillis, } from "./ha.js";
// Heuristic: normalize traces into an array and pick a "most recent"
function pickMostRecentTrace(traces) {
    if (!traces)
        return null;
    const arr = Array.isArray(traces) ? traces :
        Array.isArray(traces?.traces) ? traces.traces :
            Array.isArray(traces?.data?.traces) ? traces.data.traces :
                null;
    if (!arr?.length)
        return null;
    const ts = (t) => Date.parse(t?.timestamp ?? t?.time ?? t?.created ?? t?.last_updated ?? "") || 0;
    return [...arr].sort((a, b) => ts(b) - ts(a))[0];
}
// Heuristic: dig error-ish info out of a trace payload
function summarizeTraceFailure(trace) {
    if (!trace)
        return { status: "no_trace" };
    const err = trace?.error ??
        trace?.result?.error ??
        trace?.data?.error ??
        trace?.trace?.error ??
        null;
    const failedStep = trace?.failed_step ??
        trace?.result?.failed_step ??
        trace?.data?.failed_step ??
        null;
    if (err) {
        return {
            status: "failed",
            failure_stage: "action_or_runtime",
            details: typeof err === "string" ? err : JSON.stringify(err),
            failed_step: failedStep,
        };
    }
    const cond = trace?.condition ??
        trace?.result?.condition ??
        trace?.data?.condition ??
        null;
    if (cond && (cond?.result === false || cond?.passed === false)) {
        return {
            status: "did_not_run",
            failure_stage: "condition",
            details: "Condition(s) evaluated to false",
            condition: cond,
        };
    }
    return { status: "ran_or_unknown" };
}
/**
 * Register ALL MCP tools on the given server.
 * Used by both:
 * - stdio.ts (Claude local client)
 * - index.ts (HAOS add-on HTTP MCP)
 */
export function registerTools(mcp) {
    defineTool(mcp, {
        name: "ha_get_state",
        description: "Get the current state and attributes of a Home Assistant entity by entity_id.",
        params: { entity_id: z.string().min(1).describe("The entity_id to query (e.g., 'light.living_room')") },
        handler: async ({ entity_id }) => ({ state: await haState(entity_id) }),
    });
    defineTool(mcp, {
        name: "ha_list_services",
        description: "List all Home Assistant services grouped by domain.",
        handler: async () => ({ services: await haServices() }),
    });
    defineTool(mcp, {
        name: "supervisor_host_info",
        description: "Get host/system information from the Home Assistant Supervisor (works only when using Supervisor proxy mode).",
        handler: async () => ({ host_info: await supervisorHostInfo() }),
    });
    defineTool(mcp, {
        name: "diagnose_entity",
        description: "Return a compact diagnostic summary for an entity, including availability and last update times.",
        params: { entity_id: z.string().min(1).describe("The entity_id to diagnose") },
        handler: async ({ entity_id }) => {
            const s = await haState(entity_id);
            return {
                entity_id: s.entity_id,
                state: s.state,
                last_changed: s.last_changed,
                last_updated: s.last_updated,
                attributes: s.attributes,
                problem: s.state === "unavailable"
                    ? "Entity is unavailable"
                    : s.state === "unknown"
                        ? "Entity state is unknown"
                        : null,
            };
        },
    });
    defineTool(mcp, {
        name: "diagnose_automation",
        description: "Explain why a Home Assistant automation did or did not run in a given time window, using automation state, traces, and logbook/history context.",
        params: {
            automation_entity_id: z.string().min(1).describe("The automation entity_id to diagnose"),
            since_hours: z.number().min(1).max(168).optional().describe("Number of hours to look back (default: 24, max: 168)"),
            include_logbook: z.boolean().optional().describe("Include logbook entries (default: true)"),
            include_history: z.boolean().optional().describe("Include history data (default: false)"),
            include_raw_traces: z.boolean().optional().describe("Include raw trace data (default: false)"),
            include_config: z.boolean().optional().describe("Include automation configuration (default: true)"),
            include_raw_config: z.boolean().optional().describe("Include unredacted configuration (default: false)"),
        },
        handler: async ({ automation_entity_id, since_hours, include_logbook, include_history, include_raw_traces, include_config, include_raw_config, }) => {
            const windowHours = since_hours ?? 24;
            const endIso = toIsoFromMillis(Date.now());
            const startIso = toIsoFromMillis(Date.now() - windowHours * 60 * 60 * 1000);
            const wantConfig = include_config ?? true;
            const wantRawConfig = include_raw_config ?? false;
            const state = await haState(automation_entity_id);
            let traces = null;
            let trace = null;
            try {
                traces = await haAutomationTraces(automation_entity_id);
                trace = pickMostRecentTrace(traces);
            }
            catch (e) {
                traces = { error: String(e?.message ?? e) };
                trace = null;
            }
            const traceSummary = summarizeTraceFailure(trace);
            let logbook = null;
            if (include_logbook ?? true) {
                try {
                    logbook = await haLogbook({ startIso, endIso, entityId: automation_entity_id });
                }
                catch (e) {
                    logbook = { error: String(e?.message ?? e) };
                }
            }
            let history = null;
            if (include_history ?? false) {
                try {
                    history = await haHistoryPeriod({ startIso, endIso, entityIds: [automation_entity_id] });
                }
                catch (e) {
                    history = { error: String(e?.message ?? e) };
                }
            }
            let config = null;
            if (wantConfig) {
                try {
                    const raw = await haAutomationConfig(automation_entity_id);
                    config = wantRawConfig ? raw : sanitizeAutomationConfig(raw);
                }
                catch (e) {
                    config = { error: String(e?.message ?? e) };
                }
            }
            return {
                automation: automation_entity_id,
                window: { start: startIso, end: endIso, hours: windowHours },
                state: {
                    state: state?.state,
                    last_triggered: state?.attributes?.last_triggered ?? null,
                    mode: state?.attributes?.mode ?? null,
                    current: state?.attributes?.current ?? null,
                    friendly_name: state?.attributes?.friendly_name ?? null,
                    internal_id: state?.attributes?.id ?? null,
                },
                config,
                diagnosis: traceSummary,
                evidence: {
                    trace_sample: trace
                        ? {
                            timestamp: trace?.timestamp ?? trace?.time ?? trace?.created ?? null,
                            result: trace?.result ?? null,
                            error: trace?.error ?? trace?.result?.error ?? null,
                            failed_step: trace?.failed_step ?? trace?.result?.failed_step ?? null,
                        }
                        : null,
                    raw_traces: include_raw_traces ? traces : undefined,
                    logbook_sample: Array.isArray(logbook) ? logbook.slice(0, 20) : logbook,
                    history_sample: history,
                },
            };
        },
    });
    defineTool(mcp, {
        name: "ha_get_automation_config",
        description: "Fetch the full automation configuration (triggers, conditions, actions) for a given automation entity_id.",
        params: { automation_entity_id: z.string().min(1).describe("The automation entity_id") },
        handler: async ({ automation_entity_id }) => ({
            config: await haAutomationConfig(automation_entity_id),
        }),
    });
    defineTool(mcp, {
        name: "ha_get_automation_yaml_snippet",
        description: "Return a YAML-like snippet for an automation (trigger/condition/action/mode/etc). Use this instead of asking the user to open automations.yaml.",
        params: {
            automation_entity_id: z.string().min(1).describe("The automation entity_id"),
            include_raw_config: z.boolean().optional().describe("Return unredacted config (default: false)"),
        },
        handler: async ({ automation_entity_id, include_raw_config }) => {
            const cfg = await haAutomationConfig(automation_entity_id);
            const useRaw = include_raw_config ?? false;
            const data = useRaw ? cfg : sanitizeAutomationConfig(cfg);
            const snippet = yaml.dump(data, { noRefs: true, lineWidth: 120 });
            return {
                structuredContent: { automation: automation_entity_id, yaml_snippet: snippet, raw: useRaw },
                content: [{ type: "text", text: snippet }],
            };
        },
    });
    defineTool(mcp, {
        name: "ha_find_entities",
        description: "Search Home Assistant entities by query (matches entity_id and friendly_name). Use this to find the right entity_id before diagnosing automations or entities.",
        params: {
            query: z.string().min(1).describe("Search query to match against entity_id and friendly_name"),
            domains: z.array(z.string().min(1)).optional().describe("Optional array of domains to filter by (e.g., ['automation', 'light'])"),
            limit: z.number().min(1).max(50).optional().describe("Maximum number of results to return (default: 10, max: 50)"),
            include_disabled: z.boolean().optional().describe("Include disabled entities (default: false)"),
        },
        handler: async ({ query, domains, limit }) => {
            const q = query.toLowerCase().trim();
            const lim = limit ?? 10;
            const states = (await haStates());
            const results = states
                .filter((s) => {
                const entityId = String(s?.entity_id ?? "").toLowerCase();
                const friendly = String(s?.attributes?.friendly_name ?? "").toLowerCase();
                if (domains?.length) {
                    const d = entityId.split(".")[0];
                    if (!domains.includes(d))
                        return false;
                }
                return entityId.includes(q) || friendly.includes(q);
            })
                .slice(0, lim)
                .map((s) => ({
                entity_id: s.entity_id,
                domain: String(s.entity_id).split(".")[0],
                name: s.attributes?.friendly_name ?? null,
                state: s.state ?? null,
                device_class: s.attributes?.device_class ?? null,
                unit_of_measurement: s.attributes?.unit_of_measurement ?? null,
                area_id: s.attributes?.area_id ?? null,
            }));
            return { query, domains: domains ?? null, count: results.length, results };
        },
    });
    defineTool(mcp, {
        name: "ha_list_entities",
        description: "List Home Assistant entities, optionally filtered by domain (e.g. automation, light, sensor).",
        params: {
            domain: z.string().min(1).optional().describe("Optional domain filter (e.g., 'automation', 'light', 'sensor')"),
            limit: z.number().min(1).max(500).optional().describe("Maximum number of results (default: 100, max: 500)"),
        },
        handler: async ({ domain, limit }) => {
            const lim = limit ?? 100;
            const states = (await haStates());
            const results = states
                .filter((s) => (!domain ? true : String(s?.entity_id ?? "").startsWith(domain + ".")))
                .slice(0, lim)
                .map((s) => ({
                entity_id: s.entity_id,
                name: s.attributes?.friendly_name ?? null,
                state: s.state ?? null,
            }));
            return {
                domain: domain ?? null,
                count: results.length,
                results,
                note: states.length > lim ? `Truncated to ${lim}. Increase limit if needed.` : null,
            };
        },
    });
    defineTool(mcp, {
        name: "ha_get_automation_yaml_definition",
        description: "Fetch the YAML definition of an automation by item id (fallback for YAML-managed automations).",
        params: { automation_entity_id: z.string().min(1).describe("The automation entity_id or item id") },
        handler: async ({ automation_entity_id }) => {
            const addonUrl = process.env.HA_DIAG_ADDON_URL;
            if (!addonUrl) {
                throw new Error("HA_DIAG_ADDON_URL is not set. Point it to your HAOS add-on base URL (e.g. http://<ha-ip>:<port>).");
            }
            const itemId = automation_entity_id.startsWith("automation.")
                ? automation_entity_id.slice("automation.".length)
                : automation_entity_id;
            const r = await fetch(`${addonUrl}/yaml/automation/${encodeURIComponent(itemId)}`);
            if (!r.ok) {
                const body = await r.text();
                throw new Error(`Add-on returned ${r.status}: ${body}`);
            }
            const body = await r.text();
            return { yaml_definition: JSON.parse(body) };
        },
    });
    defineTool(mcp, {
        name: "ha_list_repairs",
        description: "List current Home Assistant Repairs (Settings → Repairs).",
        params: {
            include_raw: z.boolean().optional().describe("Include raw issue payloads (default: false)"),
            limit: z.number().min(1).max(500).optional().describe("Max issues to return (default: 200)"),
        },
        handler: async ({ include_raw, limit }) => {
            const raw = await haRepairsListIssues(); // { issues: [...] }
            const issues = (raw?.issues ?? []).slice(0, limit ?? 200).map((i) => ({
                domain: i.domain ?? null,
                issue_id: i.issue_id ?? null,
                severity: i.severity ?? null,
                is_fixable: i.is_fixable ?? null,
                is_persistent: i.is_persistent ?? null,
                created: i.created ?? i.created_at ?? null,
                breaks_in_ha_version: i.breaks_in_ha_version ?? null,
                learn_more_url: i.learn_more_url ?? null,
                translation_key: i.translation_key ?? null,
                translation_placeholders: i.translation_placeholders ?? null,
                // Some builds also include flags like ignored/dismissed depending on version/internals
                ignored: i.ignored ?? null,
                dismissed: i.dismissed ?? null,
            }));
            return {
                count: issues.length,
                issues,
                raw: include_raw ? raw : undefined,
            };
        },
    });
}
