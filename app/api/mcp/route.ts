import { createMcpHandler } from "mcp-handler";
import { withBearerAuth } from "@/lib/mcp/auth";
import { registerCampusTools } from "@/lib/mcp/server";

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

export { authenticated as GET, authenticated as POST };
