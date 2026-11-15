import { timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { withMcpAuth } from "mcp-handler";

const EXPECTED_TOKEN = process.env.MCP_AUTH_TOKEN?.trim();

/**
 * Credential bearer mode: `Authorization: Bearer <学号>:<IDS 密码>`.
 *
 * Opt-in (`MCP_PASSWORD_AUTH=1`) because it puts the campus password into every
 * client's config and into whatever logs headers. The static token keeps
 * working alongside it.
 */
const PASSWORD_AUTH = process.env.MCP_PASSWORD_AUTH === "1";

export interface CampusCredentials {
  username: string;
  password: string;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** `<username>:<password>` — the first colon separates, so passwords may contain colons. */
export function parseCredentialBearer(bearer: string): CampusCredentials | undefined {
  const split = bearer.indexOf(":");
  if (split <= 0 || split === bearer.length - 1) return undefined;
  return { username: bearer.slice(0, split), password: bearer.slice(split + 1) };
}

/** Credentials carried by an authenticated request, if any. */
export function credentialsFrom(auth: AuthInfo | undefined): CampusCredentials | undefined {
  const value = auth?.extra?.campusCredentials;
  if (!value || typeof value !== "object") return undefined;
  const { username, password } = value as Partial<CampusCredentials>;
  return username && password ? { username, password } : undefined;
}

/**
 * Bearer-token gate for /api/mcp.
 *
 * Two accepted credentials:
 *   - the static `MCP_AUTH_TOKEN` (IDE/CLI clients, no per-user identity);
 *   - `<学号>:<IDS 密码>` when `MCP_PASSWORD_AUTH=1`, which makes the server
 *     mint the campus session on the caller's behalf (see lib/campus/cred-session.ts).
 *
 * With neither variable set the endpoint stays open — local development only.
 */
export function withBearerAuth(handler: (req: Request) => Promise<Response>) {
  if (!EXPECTED_TOKEN && !PASSWORD_AUTH) return handler;

  return withMcpAuth(
    handler,
    (_req, bearerToken) => {
      if (!bearerToken) return undefined;

      if (PASSWORD_AUTH) {
        const credentials = parseCredentialBearer(bearerToken);
        if (credentials) {
          return {
            token: bearerToken,
            clientId: "ids-credentials",
            scopes: ["campus:read"],
            extra: { campusCredentials: credentials },
          } satisfies AuthInfo;
        }
      }

      if (EXPECTED_TOKEN && safeEqual(bearerToken, EXPECTED_TOKEN)) {
        return { token: bearerToken, clientId: "static-token", scopes: ["campus:read"] } satisfies AuthInfo;
      }
      return undefined;
    },
    { required: true, requiredScopes: ["campus:read"] },
  );
}
