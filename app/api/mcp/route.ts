import { createMcpHandler } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { credentialsFrom, withBearerAuth } from "@/lib/mcp/auth";
import { registerCampusTools } from "@/lib/mcp/server";
import { CredentialLoginError, sessionForCredentials } from "@/lib/campus/cred-session";
import { needsSession, withSession, type JsonRpcEnvelope } from "@/lib/mcp/credential-inject";

// Vercel functions: Node.js runtime only ('edge' is deprecated and cannot hold
// the crypto/streaming behavior the SDK expects).
export const runtime = "nodejs";
export const maxDuration = 300;
// Never cache MCP traffic.
export const dynamic = "force-dynamic";

const handler = createMcpHandler(registerCampusTools, {
  serverInfo: { name: "shanghaitech-mcp", version: "0.1.0" },
  maxSubscriptions: 0,
  verboseLogs: process.env.NODE_ENV !== "production",
});

const authenticated = withBearerAuth(handler);

/**
 * When the caller authenticated with `<学号>:<IDS 密码>`, every `tools/call`
 * gets a `session` minted for those credentials, so clients never have to run
 * `ids_login` themselves. The password stays in memory for the request only.
 */
async function withCredentialSession(req: Request): Promise<Response> {
  const auth = (req as Request & { auth?: AuthInfo }).auth;
  const credentials = credentialsFrom(auth);
  if (!credentials || req.method !== "POST") return authenticated(req);

  let body: unknown;
  try {
    body = JSON.parse(await req.clone().text());
  } catch {
    return authenticated(req);
  }

  if (!needsSession(body)) return authenticated(req);
  const message = body as JsonRpcEnvelope;

  try {
    const session = await sessionForCredentials(credentials.username, credentials.password);
    return authenticated(
      new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(withSession(message, session)),
      }),
    );
  } catch (error) {
    const failure =
      error instanceof CredentialLoginError
        ? error.message
        : `校园凭据登录失败：${error instanceof Error ? error.message : String(error)}`;
    return Response.json(
      { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32001, message: failure } },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}

export { withCredentialSession as GET, withCredentialSession as POST };
