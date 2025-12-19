import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./mcpTools.js";
console.error("MCP stdio server starting – build:", process.env.BUILD_ID ?? "dev");
const mcp = new McpServer({
    name: "home-automation-diagnostics",
    version: "0.1.0",
});
registerTools(mcp);
const transport = new StdioServerTransport();
await mcp.connect(transport);
