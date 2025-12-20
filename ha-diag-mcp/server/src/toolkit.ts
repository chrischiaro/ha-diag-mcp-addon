import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export type ToolParams = Record<string, z.ZodTypeAny>;
export type ToolHandler<P extends ToolParams, R extends Record<string, unknown>> =
  (args: z.infer<z.ZodObject<P>>) => Promise<R> | R;

export function okJson(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * sdk@1.10.2 has tricky overload/generic inference for mcp.tool().
 * We keep strong typing for *your* handler, but cast the SDK callback to `any`
 * to avoid TS2345 on BaseToolCallback.
 */
export function defineTool<P extends ToolParams, R extends Record<string, unknown>>(
  mcp: McpServer,
  spec: {
    name: string;
    description: string;
    params?: P; // defaults to {}
    title?: string;
    handler: ToolHandler<P, R>;
  }
) {
  // Pass the Zod *shape object* (not z.object(...))
  const shape = (spec.params ?? {}) as any;

  const cb = (async (args: any) => {
    try {
      const out = await spec.handler(args);
      return okJson(out);
    } catch (e: any) {
      if (e instanceof McpError) throw e;
      throw new McpError(
        ErrorCode.InternalError,
        `Tool '${spec.name}' failed: ${String(e?.message ?? e)}`
      );
    }
  }) as any;

  // Signature: (name, schemaShape, handler) or (name, description, schemaShape, handler)
  return (mcp.tool as any)(spec.name, spec.description, shape, cb);
}