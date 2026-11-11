import type {
  Icon,
  McpServer,
  RegisteredTool,
  ScopeChallengeHandler,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";

/**
 * Tool registry.
 *
 * Every tool goes through `defineTool`, which records name/title/description so
 * `campus_find` can search the live tool surface without a hand-maintained copy
 * of the metadata. Registration runs once per request (mcp-handler builds the
 * server per request), so the map is complete before any handler runs.
 *
 * No session data lives here — static metadata only.
 */

export interface ToolIndexEntry {
  name: string;
  title: string;
  description: string;
  /** Platform prefix, derived from the tool name. */
  platform: string;
}

const TOOLS = new Map<string, ToolIndexEntry>();

interface ToolConfig<Input extends StandardSchemaWithJSON, Output extends StandardSchemaWithJSON> {
  title?: string;
  description?: string;
  inputSchema?: Input;
  outputSchema?: Output;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  scopeChallenge?: ScopeChallengeHandler;
  _meta?: Record<string, unknown>;
}

/** Same signature as `McpServer.registerTool` (Standard Schema overload), plus indexing. */
export function defineTool<
  OutputArgs extends StandardSchemaWithJSON,
  InputArgs extends StandardSchemaWithJSON | undefined = undefined,
>(
  server: McpServer,
  name: string,
  config: ToolConfig<NonNullable<InputArgs>, OutputArgs> & { inputSchema?: InputArgs },
  cb: ToolCallback<InputArgs>,
): RegisteredTool {
  TOOLS.set(name, {
    name,
    title: config.title ?? name,
    description: config.description ?? "",
    platform: name.split("_")[0] ?? "",
  });
  return server.registerTool(name, config, cb);
}

export function toolIndex(): ToolIndexEntry[] {
  return [...TOOLS.values()];
}
