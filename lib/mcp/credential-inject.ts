/**
 * Pure helpers for the credential-bearer path (kept out of the Next.js route so
 * they can be tested without a request context).
 */

export interface JsonRpcEnvelope {
  id?: string | number | null;
  method?: string;
  params?: { arguments?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

/** True when this JSON-RPC message is a tool call that still lacks a session. */
export function needsSession(body: unknown): body is JsonRpcEnvelope {
  const message = body as JsonRpcEnvelope | null;
  if (!message || message.method !== "tools/call") return false;
  const args = message.params?.arguments;
  return !(args && typeof args.session === "string" && args.session.length > 0);
}

/** Copy of `body` with `params.arguments.session` set. */
export function withSession(body: JsonRpcEnvelope, session: string): JsonRpcEnvelope {
  return {
    ...body,
    params: { ...body.params, arguments: { ...(body.params?.arguments ?? {}), session } },
  };
}
