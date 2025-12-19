import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
export function okJson(data) {
    return {
        structuredContent: data,
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
}
/**
 * sdk@1.10.2 has tricky overload/generic inference for mcp.tool().
 * We keep strong typing for *your* handler, but cast the SDK callback to `any`
 * to avoid TS2345 on BaseToolCallback.
 */
export function defineTool(mcp, spec) {
    // Use proper Zod object schema even when empty
    const params = spec.params ? z.object(spec.params) : z.object({});
    const annotations = spec.title ? { title: spec.title } : {};
    const cb = (async (args, _extra) => {
        try {
            const out = await spec.handler(args);
            return okJson(out);
        }
        catch (e) {
            // Throw MCP-specific errors instead of wrapping in successful response
            // This allows the MCP client to properly handle errors
            if (e instanceof McpError) {
                throw e;
            }
            // Convert generic errors to MCP errors with proper error codes
            throw new McpError(ErrorCode.InternalError, `Tool '${spec.name}' failed: ${String(e?.message ?? e)}`);
        }
    });
    // Always use the 5-arg overload: (name, description, paramsSchema, annotations, cb)
    return mcp.tool(spec.name, spec.description, params, annotations, cb);
}
