# Repository Guidelines

## Project Overview

`shanghaitech-mcp` is a **campus MCP (Model Context Protocol) server for ShanghaiTech University**. Goal: one deployed endpoint that exposes campus platforms (CourseBench, EAMS, eGate, eCourse, gym booking, …) as MCP tools, with per-student identity derived from the campus IDS 统一身份认证.

Current state (v0.1.0): the MCP endpoint and the tool-registration layer are live; three CourseBench tools are implemented against public data (no campus login required). IDS authentication helpers exist but the per-user OAuth bridge is **not** wired yet — the endpoint is protected by a single optional static bearer token. Do not document or claim per-user campus auth until it lands.

## Architecture & Data Flow

```
MCP client (Claude / Cursor / Codex / Inspector)
  │  Streamable HTTP, POST /api/mcp
  ▼
app/api/mcp/route.ts        Next.js route handler
  │  withBearerAuth()       optional static token gate (lib/mcp/auth.ts)
  ▼
mcp-handler@2 createMcpHandler(registerCampusTools)   ← once per HTTP request
  │
  ▼
lib/mcp/server.ts           registers tools; each tool is a thin adapter
  │
  ▼
lib/campus/*.ts             one module per upstream platform
  └─ coursebench.ts         fetch + envelope unwrap + filtering
  └─ ids.ts                 CAS URLs + p3/serviceValidate ticket redemption
```

Key properties to preserve:

- **Stateless by construction.** `mcp-handler@2` builds the server per request; there is no `Mcp-Session-Id`, no in-memory `Map`, no SSE session store. Anything that must survive across tool calls becomes an explicit handle argument backed by a real store (Postgres/Redis) — never module-level state, because Vercel instances are not shared.
- **One module per upstream platform** under `lib/campus/`, exposing typed functions plus a typed error class (`CourseBenchError`). Tool code only formats; it does not `fetch` upstream APIs directly.
- **Failures are data.** Upstream errors are converted into MCP tool results with `isError: true` and a readable Chinese message; they never throw out of the handler.
- Auth architecture (decided, not yet built): the server is both OAuth 2.1 authorization server and protected resource. Campus IDS is the **login backend** of `/authorize`, never the MCP credential — the spec forbids token passthrough. Access tokens must be JWTs with `aud` = the MCP endpoint URL.

## Key Directories

| Path | Purpose |
|---|---|
| `app/api/mcp/route.ts` | The only MCP entry point; route segment config (`runtime`, `maxDuration`, `dynamic`). |
| `app/page.tsx`, `app/layout.tsx` | Minimal landing page (endpoint URL, tool list, connector snippet). |
| `lib/mcp/server.ts` | `registerCampusTools(server)` — every tool definition lives here. |
| `lib/mcp/auth.ts` | `withBearerAuth()` — static-token gate; the place where OAuth resource-server verification will replace `withMcpAuth`. |
| `lib/campus/` | Upstream platform clients (`coursebench.ts`, `ids.ts`). |
| `scripts/smoke-mcp.sh` | initialize + tools/list against a running endpoint. |

## Development Commands

```bash
pnpm install
pnpm dev                 # http://localhost:3000, MCP at /api/mcp
pnpm lint                # tsc --noEmit (no ESLint configured yet)
pnpm build               # next build — must pass before pushing
pnpm start               # serve the production build
pnpm mcp:inspect         # Inspector CLI: tools/list against localhost:3000

./scripts/smoke-mcp.sh http://localhost:3000/api/mcp            # no token
./scripts/smoke-mcp.sh https://<host>/api/mcp "$MCP_AUTH_TOKEN" # with token
```

Raw protocol check (legacy era, the one most clients use):

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Code Conventions & Common Patterns

- **TypeScript strict**, `noUncheckedIndexedAccess`. No `any`; type upstream payloads with interfaces in the platform module. Path alias `@/*` → repo root.
- **Naming**: files `kebab-case.ts`; exported functions verb-first (`searchCourses`, `getCourseComments`, `validateServiceTicket`); tool names `<platform>_<verb>_<noun>` in `snake_case` (`coursebench_search_courses`).
- **Tool contract**: `registerTool(name, { title, description, inputSchema: z.object({...}), annotations }, handler)`. Inputs are Zod objects (v2 SDK Standard Schema), always with `.describe()` in Chinese. `annotations.readOnlyHint: true` for read-only tools. Return `{ content: [{ type: "text", text }] }`.
- **User-facing strings are Chinese** (tool descriptions, error messages, page copy). Code comments and identifiers are English.
- **Async/errors**: `async` handlers, `AbortSignal.timeout(...)` on every outbound fetch, explicit `res.ok` checks, typed error classes per platform. No silent `catch {}`; convert to a user-visible result or rethrow with context.
- **Env access** only at module scope or in the function that owns it, always with a default (`process.env.X ?? "https://…"`); secrets never logged, never in tool arguments.
- **Next.js route config**: `runtime = "nodejs"` (edge deprecated), `maxDuration = 300`, `dynamic = "force-dynamic"`. Do not add `basePath`/`sseEndpoint`-style options — removed in `mcp-handler` 2.x.

## Important Files

- `app/api/mcp/route.ts` — entry point; the export shape (`GET`/`POST`) is the API contract.
- `lib/mcp/server.ts` — single source of truth for exposed tools.
- `lib/mcp/auth.ts` — authentication seam.
- `lib/campus/ids.ts` — CAS wire facts (`/authserver/login`, `/authserver/p3/serviceValidate?format=JSON`). Treat these paths and behaviours as verified production facts.
- `.env.example` — every supported env var; `MCP_AUTH_TOKEN`, `IDS_BASE_URL`, `COURSEBENCH_BASE_URL`, `PUBLIC_BASE_URL`.
- `next.config.ts`, `tsconfig.json`, `package.json` — nothing exotic; keep them boring.

## Runtime/Tooling Preferences

- **Node.js ≥ 20.9** (Vercel Node runtime), **pnpm** (`pnpm-lock.yaml` is the lockfile of record), Next.js 16 App Router.
- Pinned versions that are known-good together: `next@16.4.6`, `react@19.3.1`, `mcp-handler@2.3.1`, `@modelcontextprotocol/server@2.4.0` (v2 SDK, spec 2026-07-28 + 2025-era stateless fallback), `zod@4.6.7`, `typescript@7.0.2`.
- Do **not** introduce `@modelcontextprotocol/sdk` (v1 maintenance line), `@vercel/mcp-adapter` (superseded), `@vercel/kv` (sunset) or the 2024-11-05 HTTP+SSE transport.
- No stdio transport in this repo: Vercel functions are per-request. Local stdio access, if ever needed, is `mcp-remote` on the client side.
- Region: `hkg1` for China latency. Hobby caps: 300 s `maxDuration`, 1 WAF rate-limit rule — plan rate limiting in code (`@upstash/ratelimit`) rather than relying on WAF.

## Testing & QA

- No unit-test framework yet. Gates before pushing: `pnpm lint` (tsc) and `pnpm build`, then `scripts/smoke-mcp.sh` against a running build.
- Manual protocol verification uses the MCP Inspector (`pnpm mcp:inspect`) or the `curl` snippet above; a real client (Claude/Cursor) is the final check for auth/connector behaviour.
- When platform clients grow logic (parsing, retries, credential derivation), add `vitest` and test the pure functions (`averageScore`, ticket-response parsing, error-string classification). Do not write tests that only assert a fetch was called.
- Never test campus flows with real credentials from CI. Captcha escalation on IDS is keyed to **egress IP**; repeated failed logins from one host poison captcha state for every user behind that IP.
