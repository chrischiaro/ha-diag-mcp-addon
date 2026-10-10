import readline from "node:readline";
import fetch from "node-fetch";
const MCP_URL = process.argv[2];
if (!MCP_URL) {
    console.error("Usage: stdio-http-proxy <mcp_url>");
    process.exit(1);
}
// Bearer token for the add-on's `auth_token` option. Read from the environment so it never appears in
// the MCP client config or the process arguments. stdout carries the protocol, so warnings go to stderr.
const AUTH_TOKEN = (process.env.HA_DIAG_AUTH_TOKEN ?? "").trim();
if (!AUTH_TOKEN) {
    console.error("stdio-http-proxy: HA_DIAG_AUTH_TOKEN is not set; requests will be rejected if the server requires a token.");
}
let sessionId = null;
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
});
function writeError(id, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: id ?? null }) + "\n");
}
function hintFor(status) {
    if (status === 401)
        return " Check that HA_DIAG_AUTH_TOKEN matches the add-on's `auth_token` option.";
    if (status === 503)
        return " The add-on has no `auth_token` configured; set it in the add-on options.";
    if (status === 400 || status === 404)
        return " The MCP session may be stale (e.g. the add-on restarted); reconnect this MCP server.";
    return "";
}
async function send(msg) {
    const res = await fetch(MCP_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        },
        body: JSON.stringify(msg),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid)
        sessionId = sid;
    const text = await res.text();
    // Surface HTTP errors instead of swallowing them; otherwise the client waits forever for a reply.
    if (!res.ok) {
        const detail = `HTTP ${res.status} from ${MCP_URL}: ${text.slice(0, 200).trim()}${hintFor(res.status)}`;
        if (msg?.id !== undefined)
            writeError(msg.id, detail);
        else
            console.error(`stdio-http-proxy: ${detail}`);
        return;
    }
    // extract SSE data lines
    for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
            process.stdout.write(line.slice(6) + "\n");
        }
    }
}
rl.on("line", async (line) => {
    let msg;
    try {
        msg = JSON.parse(line);
    }
    catch (e) {
        writeError(null, `Invalid JSON from client: ${String(e)}`);
        return;
    }
    try {
        await send(msg);
    }
    catch (e) {
        writeError(msg?.id, String(e));
    }
});
