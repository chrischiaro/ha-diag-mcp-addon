import readline from "node:readline";
import fetch from "node-fetch";

const MCP_URL = process.argv[2];
if (!MCP_URL) {
  console.error("Usage: stdio-http-proxy <mcp_url>");
  process.exit(1);
}

let sessionId: string | null = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

async function send(msg: any) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(msg),
  });

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  const text = await res.text();

  // extract SSE data lines
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      process.stdout.write(line.slice(6) + "\n");
    }
  }
}

rl.on("line", async (line) => {
  try {
    const msg = JSON.parse(line);
    await send(msg);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: String(e) },
        id: null,
      }) + "\n"
    );
  }
});