import { z } from "zod";
import yaml from "js-yaml";
import { defineTool } from "./toolkit.js";
import { addonHeaders, selfUrl } from "./auth.js";
import { haAutomationConfig, haAutomationTraces, haLogbook, haHistoryPeriod, haRepairsListIssues, haServices, haState, haStates, sanitizeAutomationConfig, supervisorHostInfo, toIsoFromMillis, haCallService, haRenderTemplate, haErrorLog, } from "./ha.js";
// trace/list items carry timestamp as { start, finish }; older heuristics used a plain string.
function traceStartMs(t) {
    const raw = t?.timestamp?.start ?? t?.timestamp ?? t?.time ?? t?.created ?? t?.last_updated ?? "";
    return Date.parse(raw) || 0;
}
// Resolve a query window from explicit ISO start/end (include a timezone offset, e.g. 2026-10-09T09:40:00+02:00)
// or from "last N hours". Returned timestamps are UTC ISO strings.
const MAX_WINDOW_HOURS = 168;
// Full date-time with an explicit timezone: Z or +HH:MM / -HHMM. Date.parse would otherwise read a
// bare date-time as server-local time and a bare date as UTC, silently shifting the window.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
function parseIsoWithOffset(value, field) {
    if (!ISO_WITH_OFFSET.test(value.trim())) {
        throw new Error(`Invalid '${field}' timestamp '${value}': use ISO 8601 with a timezone, e.g. 2026-10-09T09:40:00+02:00 or 2026-10-09T07:40:00Z`);
    }
    const ms = Date.parse(value.trim());
    if (Number.isNaN(ms))
        throw new Error(`Invalid '${field}' timestamp: ${value}`);
    return ms;
}
function resolveWindow(args, defaultHours) {
    const endMs = args.end ? parseIsoWithOffset(args.end, "end") : Date.now();
    let startMs;
    if (args.start) {
        startMs = parseIsoWithOffset(args.start, "start");
    }
    else {
        startMs = endMs - (args.since_hours ?? defaultHours) * 60 * 60 * 1000;
    }
    if (startMs >= endMs)
        throw new Error("'start' must be before 'end'");
    if (endMs - startMs > MAX_WINDOW_HOURS * 60 * 60 * 1000) {
        throw new Error(`Window too large: max ${MAX_WINDOW_HOURS} hours (7 days) between start and end`);
    }
    return { startIso: toIsoFromMillis(startMs), endIso: toIsoFromMillis(endMs) };
}
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
    return [...arr].sort((a, b) => traceStartMs(b) - traceStartMs(a))[0];
}
// Heuristic: dig error-ish info out of a trace payload
function summarizeTraceFailure(trace) {
    if (!trace)
        return { status: "no_trace" };
    // script_execution (from HA's trace/list): finished | failed_conditions | failed_single |
    // failed_max_runs | aborted | cancelled | error
    const exec = trace?.script_execution ?? null;
    if (exec === "failed_conditions") {
        return {
            status: "did_not_run",
            failure_stage: "condition",
            details: `Trigger fired but a condition failed (last step: ${trace?.last_step ?? "unknown"})`,
            last_step: trace?.last_step ?? null,
        };
    }
    if (exec === "failed_single" || exec === "failed_max_runs") {
        return {
            status: "did_not_run",
            failure_stage: "mode",
            details: "Trigger fired but the run was blocked because the automation was already running (mode/max)",
            last_step: trace?.last_step ?? null,
        };
    }
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
                traces = await haAutomationTraces(automation_entity_id, { includeLatestFull: include_raw_traces ?? false });
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
                    config = {
                        error: String(e?.message ?? e),
                        hint: "A 404 usually means the automation is defined in YAML (e.g. /config/packages/), not the UI. Use ha_find_file / ha_grep_file on its id or alias.",
                    };
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
                            run_id: trace?.run_id ?? null,
                            timestamp: trace?.timestamp ?? trace?.time ?? trace?.created ?? null,
                            script_execution: trace?.script_execution ?? null,
                            last_step: trace?.last_step ?? null,
                            result: trace?.result ?? null,
                            error: trace?.error ?? trace?.result?.error ?? null,
                            failed_step: trace?.failed_step ?? trace?.result?.failed_step ?? null,
                        }
                        : null,
                    trace_note: traces?.note ?? undefined,
                    recent_runs: Array.isArray(traces?.traces)
                        ? [...traces.traces]
                            .sort((a, b) => traceStartMs(b) - traceStartMs(a))
                            .slice(0, 5)
                            .map((t) => ({
                            run_id: t?.run_id ?? null,
                            start: t?.timestamp?.start ?? null,
                            finish: t?.timestamp?.finish ?? null,
                            script_execution: t?.script_execution ?? null,
                            last_step: t?.last_step ?? null,
                            error: t?.error ?? null,
                        }))
                        : undefined,
                    raw_traces: include_raw_traces ? traces : undefined,
                    logbook_sample: Array.isArray(logbook) ? logbook.slice(0, 20) : logbook,
                    history_sample: history,
                },
            };
        },
    });
    defineTool(mcp, {
        name: "ha_get_history",
        description: "Get recorded state history for one or more entities over a time window, as compact [timestamp, state] points (timestamps are UTC). Use this to find exactly when a sensor crossed a threshold.",
        params: {
            entity_ids: z.array(z.string().min(1)).min(1).max(10).describe("Entity ids to fetch (max 10)"),
            start: z.string().optional().describe("Window start, ISO 8601 WITH timezone (Z or offset), e.g. 2026-10-09T09:40:00+02:00. Overrides since_hours. Max window: 7 days."),
            end: z.string().optional().describe("Window end, ISO 8601 WITH timezone (Z or offset) (default: now)"),
            since_hours: z.number().min(0.01).max(168).optional().describe("Look back this many hours from end when start is not given (default: 3, max: 168)"),
            significant_changes_only: z.boolean().optional().describe("Set false to include every recorded state change (HA default drops some attribute-only/insignificant changes)"),
            max_points: z.number().min(1).max(5000).optional().describe("Max points per entity (default: 2000). If exceeded, the NEWEST points are returned and truncated=true; narrow the window to see earlier ones."),
        },
        handler: async ({ entity_ids, start, end, since_hours, significant_changes_only, max_points }) => {
            const { startIso, endIso } = resolveWindow({ start, end, since_hours }, 3);
            const cap = max_points ?? 2000;
            const raw = (await haHistoryPeriod({
                startIso,
                endIso,
                entityIds: entity_ids,
                minimalResponse: true,
                noAttributes: true,
                significantChangesOnly: significant_changes_only,
            }));
            const series = (Array.isArray(raw) ? raw : []).map((states) => {
                const all = Array.isArray(states) ? states : [];
                // Keep the NEWEST points when over the cap: the usual question is "what happened just before now".
                const points = all
                    .slice(-cap)
                    .map((s) => [s?.last_changed ?? s?.last_updated ?? null, s?.state ?? null]);
                return {
                    entity_id: all[0]?.entity_id ?? null,
                    total_points: all.length,
                    returned_points: points.length,
                    truncated: all.length > cap,
                    points,
                };
            });
            // minimal_response only names the entity on the first state of each series; fall back to request order
            series.forEach((s, i) => { if (!s.entity_id)
                s.entity_id = entity_ids[i] ?? null; });
            return {
                window: { start: startIso, end: endIso },
                timezone_note: "All timestamps are UTC as returned by Home Assistant.",
                first_point_note: "The first point of a series is the state as of the window start (or the earliest record), not necessarily a real change time. If truncated=true, only the newest points are returned; narrow the window to see earlier ones.",
                series,
                missing_entities: entity_ids.filter((id) => !series.some((s) => s.entity_id === id)),
            };
        },
    });
    defineTool(mcp, {
        name: "ha_get_logbook",
        description: "Get Home Assistant logbook entries for a time window (timestamps are UTC), optionally for one entity and/or filtered by text. Use search='started' or 'stopped' to find Home Assistant restarts, or an automation name to see when it ran.",
        params: {
            start: z.string().optional().describe("Window start, ISO 8601 WITH timezone (Z or offset), e.g. 2026-10-09T09:40:00+02:00. Overrides since_hours. Max window: 7 days."),
            end: z.string().optional().describe("Window end, ISO 8601 WITH timezone (Z or offset) (default: now)"),
            since_hours: z.number().min(0.01).max(168).optional().describe("Look back this many hours from end when start is not given (default: 6, max: 168)"),
            entity_id: z.string().min(1).optional().describe("Only entries for this entity"),
            search: z.string().min(1).optional().describe("Case-insensitive text filter applied to name, message, state, entity_id and domain"),
            limit: z.number().min(1).max(500).optional().describe("Max entries to return (default: 100). Earliest entries first."),
        },
        handler: async ({ start, end, since_hours, entity_id, search, limit }) => {
            const { startIso, endIso } = resolveWindow({ start, end, since_hours }, 6);
            const lim = limit ?? 100;
            const raw = (await haLogbook({ startIso, endIso, entityId: entity_id }));
            const entries = Array.isArray(raw) ? raw : [];
            const q = search?.toLowerCase();
            const matched = q
                ? entries.filter((e) => [e?.name, e?.message, e?.state, e?.entity_id, e?.domain]
                    .some((f) => typeof f === "string" && f.toLowerCase().includes(q)))
                : entries;
            return {
                window: { start: startIso, end: endIso },
                timezone_note: "All timestamps are UTC as returned by Home Assistant.",
                total_in_window: entries.length,
                matched: matched.length,
                returned: Math.min(matched.length, lim),
                truncated: matched.length > lim,
                entries: matched.slice(0, lim).map((e) => ({
                    when: e?.when ?? null,
                    name: e?.name ?? null,
                    message: e?.message ?? null,
                    state: e?.state ?? null,
                    entity_id: e?.entity_id ?? null,
                    domain: e?.domain ?? null,
                })),
            };
        },
    });
    defineTool(mcp, {
        name: "ha_get_error_log",
        description: "Read the Home Assistant Core log for the CURRENT run only (it starts at the last Home Assistant start; it will not contain the shutdown that preceded it). Supports a plain-text filter and tail. Needs Core to keep a log file (on Supervisor installs, enable the Core option duplicate_log_file); otherwise Home Assistant returns 404.",
        params: {
            search: z.string().min(1).max(200).optional().describe("Case-insensitive plain-text filter (not a regex); only lines containing it are returned"),
            tail_lines: z.number().min(1).max(2000).optional().describe("Return only the last N (matching) lines (default: 200, max: 2000)"),
        },
        handler: async ({ search, tail_lines }) => {
            let text;
            try {
                text = await haErrorLog();
            }
            catch (e) {
                const msg = String(e?.message ?? e);
                if (msg.includes(" 404")) {
                    throw new Error("Home Assistant has no /api/error_log route: Core is not writing a log file. On Supervisor installs this is the default; enable the Core option `duplicate_log_file` (then restart Core), or read logs with `ha core logs` on the host. Original error: " + msg);
                }
                throw e;
            }
            // eslint-disable-next-line no-control-regex
            const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
            // Plain substring match: a caller-supplied regex can hang the single-threaded server (ReDoS).
            const needle = search?.toLowerCase();
            const matched = needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;
            const n = tail_lines ?? 200;
            const out = matched.slice(-n);
            return {
                note: "Current run only; entries before the last Home Assistant start are not included.",
                total_lines: lines.length,
                matched: matched.length,
                returned: out.length,
                lines: out,
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
    // New filesystem and service tools
    defineTool(mcp, {
        name: "ha_read_file",
        description: "Read any file from the Home Assistant /config filesystem. Use start_line/end_line to page through files larger than max_size.",
        params: {
            path: z.string().min(1).describe("Full path to the file (must be within /config/)"),
            max_size: z.number().min(1).max(1000000).optional().describe("Maximum content size in bytes (default: 100000). Increase if needed."),
            start_line: z.number().min(1).optional().describe("First line to return, 1-indexed (default: start of file)"),
            end_line: z.number().min(1).optional().describe("Last line to return, 1-indexed inclusive (default: end of file)"),
        },
        handler: async ({ path, max_size, start_line, end_line }) => {
            const r = await fetch(`${selfUrl()}/fs/read`, {
                method: "POST",
                headers: addonHeaders(),
                body: JSON.stringify({ path, max_size, start_line, end_line }),
            });
            if (!r.ok) {
                const body = await r.text();
                throw new Error(`Add-on returned ${r.status}: ${body}`);
            }
            return r.json();
        },
    });
    defineTool(mcp, {
        name: "ha_find_file",
        description: "Find files by name within the Home Assistant /config directory. Use this to locate configuration files.",
        params: {
            filename: z.string().min(1).describe("Filename or pattern to search for (e.g., 'automations.yaml')"),
            search_root: z.string().optional().describe("Root directory to search from (default: /config)"),
        },
        handler: async ({ filename, search_root }) => {
            const r = await fetch(`${selfUrl()}/fs/find`, {
                method: "POST",
                headers: addonHeaders(),
                body: JSON.stringify({ filename, search_root }),
            });
            if (!r.ok) {
                const body = await r.text();
                throw new Error(`Add-on returned ${r.status}: ${body}`);
            }
            return r.json();
        },
    });
    defineTool(mcp, {
        name: "ha_grep_file",
        description: "Search for a pattern within a file and return matching lines with context. Use this to find specific configurations or patterns in files.",
        params: {
            path: z.string().min(1).describe("Full path to the file (must be within /config/)"),
            pattern: z.string().min(1).describe("Search pattern (regex supported)"),
            context_lines: z.number().min(0).max(20).optional().describe("Number of context lines before/after match (default: 5)"),
        },
        handler: async ({ path, pattern, context_lines }) => {
            const r = await fetch(`${selfUrl()}/fs/grep`, {
                method: "POST",
                headers: addonHeaders(),
                body: JSON.stringify({ path, pattern, context_lines }),
            });
            if (!r.ok) {
                const body = await r.text();
                throw new Error(`Add-on returned ${r.status}: ${body}`);
            }
            return r.json();
        },
    });
    defineTool(mcp, {
        name: "ha_write_file",
        description: "Write content to any file in the Home Assistant /config filesystem. Use this to update configuration files, automations.yaml, etc. WARNING: This overwrites the entire file.",
        params: {
            path: z.string().min(1).describe("Full path to the file (must be within /config/)"),
            content: z.string().describe("Complete file content to write"),
        },
        handler: async ({ path, content }) => {
            const r = await fetch(`${selfUrl()}/fs/write`, {
                method: "POST",
                headers: addonHeaders(),
                body: JSON.stringify({ path, content }),
            });
            if (!r.ok) {
                const body = await r.text();
                throw new Error(`Add-on returned ${r.status}: ${body}`);
            }
            return r.json();
        },
    });
    defineTool(mcp, {
        name: "ha_call_service",
        description: "Call any Home Assistant service directly (e.g., automation.trigger, automation.reload, homeassistant.reload_all). Use this to trigger automations, reload configs, or execute any HA service.",
        params: {
            domain: z.string().min(1).describe("Service domain (e.g., 'automation', 'homeassistant', 'light')"),
            service: z.string().min(1).describe("Service name (e.g., 'trigger', 'reload', 'turn_on')"),
            service_data: z.record(z.any()).optional().describe("Service data/parameters (optional)"),
            target: z.object({
                entity_id: z.union([z.string(), z.array(z.string())]).optional(),
                device_id: z.union([z.string(), z.array(z.string())]).optional(),
                area_id: z.union([z.string(), z.array(z.string())]).optional(),
            }).optional().describe("Target entities, devices, or areas (optional)"),
        },
        handler: async ({ domain, service, service_data, target }) => {
            try {
                const result = await haCallService(domain, service, service_data, target);
                return {
                    success: true,
                    domain,
                    service,
                    result,
                };
            }
            catch (e) {
                return {
                    success: false,
                    domain,
                    service,
                    error: String(e?.message ?? e),
                };
            }
        },
    });
    defineTool(mcp, {
        name: "ha_replace_in_file",
        description: "Replace a specific string within a Home Assistant config file. Prefer this over ha_write_file for targeted edits — no need to send the entire file content.",
        params: {
            path: z.string().min(1).describe("Full path to the file (must be within /config/)"),
            old_string: z.string().min(1).describe("Exact string to find and replace"),
            new_string: z.string().describe("Replacement string"),
            replace_all: z.boolean().optional().describe("Replace all occurrences instead of just the first (default: false)"),
        },
        handler: async ({ path, old_string, new_string, replace_all }) => {
            const r = await fetch(`${selfUrl()}/fs/replace`, {
                method: "POST",
                headers: addonHeaders(),
                body: JSON.stringify({ path, old_string, new_string, replace_all }),
            });
            if (!r.ok) {
                const body = await r.text();
                throw new Error(`Add-on returned ${r.status}: ${body}`);
            }
            return r.json();
        },
    });
    defineTool(mcp, {
        name: "ha_evaluate_template",
        description: "Evaluate a Jinja2 template against the live Home Assistant state. Use this to test conditions, check state values, or debug template logic.",
        params: {
            template: z.string().min(1).describe("Jinja2 template to evaluate (e.g., '{{ states(\"sensor.temperature\") }}')"),
        },
        handler: async ({ template }) => {
            try {
                const result = await haRenderTemplate(template);
                return {
                    success: true,
                    template,
                    result,
                };
            }
            catch (e) {
                return {
                    success: false,
                    template,
                    error: String(e?.message ?? e),
                };
            }
        },
    });
}
