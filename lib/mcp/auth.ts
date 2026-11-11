import { timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { withMcpAuth } from "mcp-handler";

const EXPECTED_TOKEN = process.env.MCP_AUTH_TOKEN?.trim();

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Bearer-token gate for /api/mcp.
 *
 * Interim authentication only (IDE/CLI clients): set MCP_AUTH_TOKEN and every
 * request must carry `Authorization: Bearer <token>`. When the variable is
 * absent the endpoint stays open — required for local development, must never
 * be the case in production.
 *
 * Per-user campus identity (OAuth 2.1 + IDS delegated login) replaces this.
 */
export function withBearerAuth(handler: (req: Request) => Promise<Response>) {
  if (!EXPECTED_TOKEN) return handler;

  return withMcpAuth(
    handler,
    (_req, bearerToken) => {
      if (!bearerToken || !safeEqual(bearerToken, EXPECTED_TOKEN)) return undefined;
      return { token: bearerToken, clientId: "static-token", scopes: ["campus:read"] } satisfies AuthInfo;
    },
    { required: true, requiredScopes: ["campus:read"] },
  );
}
