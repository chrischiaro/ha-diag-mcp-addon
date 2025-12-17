import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
  const params = (spec.params ?? {}) as P;
  const annotations = spec.title ? { title: spec.title } : {};

  const cb = (async (args: any, _extra: any) => {
    try {
      const out = await spec.handler(args);
      return okJson(out);
    } catch (e: any) {
      return okJson({
        tool: spec.name,
        error: String(e?.message ?? e),
      });
    }
  }) as any;

  // Always use the 5-arg overload: (name, description, paramsSchema, annotations, cb)
  return (mcp.tool as any)(spec.name, spec.description, params, annotations, cb);
}