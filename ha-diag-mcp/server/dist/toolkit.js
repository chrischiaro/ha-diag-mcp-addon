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
  // Pass the Zod *shape object* (not z.object(...))
  const shape = spec.params ?? {};
  const cb = async (args) => {
    try {
      // Normalize args from various MCP clients:
      // - Some pass tool args directly
      // - Some nest as { arguments: {...} }
      // - Some use camelCase instead of snake_case
      let normalized = args ?? {};
      if (
        normalized &&
        typeof normalized === "object" &&
        normalized.arguments &&
        typeof normalized.arguments === "object"
      ) {
        normalized = normalized.arguments;
      }
      if (spec.params && normalized && typeof normalized === "object") {
        for (const key of Object.keys(spec.params)) {
          if (normalized[key] !== undefined) continue;
          const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
          if (normalized[camel] !== undefined)
            normalized[key] = normalized[camel];
        }
      }
      const out: any = await spec.handler(normalized);

      // If a tool already returns a valid MCP tool result, pass it through
      if (out && typeof out === "object" && Array.isArray(out.content)) {
        return out;
      }

      return okJson(out);
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw new McpError(
        ErrorCode.InternalError,
        `Tool '${spec.name}' failed: ${String(e?.message ?? e)}`
      );
    }
  };
  // Signature: (name, schemaShape, handler) or (name, description, schemaShape, handler)
  return mcp.tool(spec.name, spec.description, shape, cb);
}
