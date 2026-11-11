# Repository Guidelines

## Project Overview

`shanghaitech-mcp` is a **campus MCP (Model Context Protocol) server for ShanghaiTech University**. Goal: one deployed endpoint that exposes campus platforms (CourseBench, EAMS, eGate, eCourse, gym booking, …) as MCP tools, with per-student identity derived from the campus IDS 统一身份认证.

Current state (v0.1.0): the MCP endpoint and the tool-registration layer are live; three CourseBench tools work against public data; `ids_login` logs into campus IDS with a student's username/password and returns a sealed, expiring session handle (`ids_status` verifies it). There is **no OAuth** — an explicit product decision. The MCP endpoint itself is protected by an optional static bearer token (`MCP_AUTH_TOKEN`).

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
  └─ coursebench.ts         public data, no auth
  └─ ids.ts                 CAS URLs + p3/serviceValidate ticket redemption
  └─ ids-auth.ts            password login → CASTGC, error mapping
  └─ http.ts                cookie jar + manual redirect following (shared)
  └─ eams.ts / egate.ts     platform adapters: CASTGC → platform cookies → data
```

Key properties to preserve:

- **Stateless by construction.** `mcp-handler@2` builds the server per request; there is no `Mcp-Session-Id`, no in-memory `Map`, no SSE session store. Anything that must survive across tool calls becomes an explicit handle argument backed by a real store (Postgres/Redis) — never module-level state, because Vercel instances are not shared.
- **One module per upstream platform** under `lib/campus/`, exposing typed functions plus a typed error class (`CourseBenchError`, `CampusSessionExpired`). Tool code only formats; it does not `fetch` upstream APIs directly.
- **Platform session pattern**: never hardcode a CAS `service=`. Request the platform's own entry URL with the CASTGC in the jar and let the site 302 to IDS itself; follow every hop with `follow()` from `lib/campus/http.ts` so each `Set-Cookie` is captured. Success = final URL is not on `ids.shanghaitech.edu.cn` and the body lacks `统一身份认证`.
- **Every platform needs its priming call** before data endpoints: EAMS `/eams/home.action`, eGate `/xsfw/sys/funauthapp/api/getAppConfig/xshdapp-4770201649822494.do?v=<ts>`. Without it the first data call returns an uninitialized shell.
- **The 4.5KB "shell" is a rate-limit page, not an uninitialized session.** Its text is `Please DO NOT click too quickly.`; EAMS serves it when the same session is hit too fast (back-to-back home+courseTable is enough). `eamsFetch()` detects that marker and retries with 1s/3s/6s/10s backoff, then fails with an explicit message. Never parse a 4–5KB EAMS page.
- **EAMS language = the language used at the last IDS login**, stored account-side. Verified: logging in while the IDS page was English made EAMS English (`Student No`, `Name`), re-logging in with the page in Chinese made EAMS Chinese (`学号`, `姓名`, exam type `期中考试`). Request-level levers do **not** work — `?locale=`, `?request_locale=`, `?lang=`, and the `LOCALE`/`lang`/`platformMultilingual` cookies against eams host all had no effect, and the CAS `p3/serviceValidate` attributes carry no locale. Control it at login: `ids_login({lang})` seeds `org.springframework.web.servlet.i18n.CookieLocaleResolver.LOCALE` on the IDS host before the POST. Every EAMS parser must still accept both label sets.
- **ELRC responses wrap data twice** (`{data:{data:[…]}}` for clips, `{data:{results:[…]}}` for courses). Parse the envelope explicitly; a `.loose()` schema on the wrong level silently returns empty results.
- **ELRC media (slides/posters) live under `/bucket-…`** on the same host and also need the session, so `downloadUrl(..., base)` carries the upstream base; `lib/campus/download.ts` allowlists `{BB: /bbcswebdav/}`, `{ELRC: /bucket-}` only.
- **Blackboard files are behind a cookie**, so `elearning_download` does not return the upstream URL. It mints a 10-minute sealed token and returns `{origin}/api/download?t=…`, which proxies the file with the session (see `lib/campus/download.ts`). Never inline courseware bytes into `structuredContent`.
- **Do not conflate eCourse quizzes with EAMS exams.** TronClass `/api/courses/{id}/exams` returns in-course 在线测验 (titles like `Homework 1`); real 期中/期末考试 live only in EAMS (`stdExamTable!innerIndex.action` -> batch select -> `stdExamTable!examTable.action`). Tools: `ecourse_quizzes` vs `eams_exams`.
- **Sessions are two-level, in Redis.** `ids_login` stores the root (CASTGC) at `st:<sid>:root` (TTL 12 h); each platform's derived material lives at `st:<sid>:d:<platform>` (TTL 30 min). `platformAuth(handle, platform)` returns the cached derived entry, else re-mints it from the root, else fails with "重新 ids_login". Values are sealed with `MCP_ENC_KEY`, so a Redis dump alone is not a credential dump. Without `UPSTASH_REDIS_REST_*` a per-process map is used for local dev only (`lib/campus/session-store.ts`).
- **One credential type: `AuthContext`.** Adapters return `{ headers, jar? }` (cookie platforms fill `jar`, libspace fills `headers: { token }`); `authOptions()` folds it into `follow()`. Tools only ever pass the sealed `session` handle — never a cookie or token — so adding a platform with a different transport auth does not leak upward.
- **Consumed tickets are single-use**: never retry a hop that carried `ticket=ST-…`; re-derive the whole platform session instead.
- **Page language is account state, not a request header.** EAMS renders in whatever language the account picked on the IDS login page (`org.springframework.web.servlet.i18n.CookieLocaleResolver.LOCALE` written by the page's own JS, then stored IDS-side). Replaying that cookie against `eams.shanghaitech.edu.cn` does **not** switch the page (verified: `zh_CN` and `en` both returned Chinese). Therefore every HTML parser must accept both labels (`姓名|Name`, `Student No`) and fail loudly — never return both-fields-null.
- **Failures are data.** Upstream errors are converted into MCP tool results with `isError: true` and a readable Chinese message; they never throw out of the handler.
- **Auth is credential login, not OAuth.** `ids_login` takes IDS username + password, performs the real CAS form login (`GET login page → checkNeedCaptcha → POST login → CASTGC`), and returns an opaque `v1.<iv>.<tag>.<ct>` handle sealed with AES-256-GCM (`MCP_ENC_KEY`). Passwords are used in-request and never persisted. Campus state travels in the handle — no DB, no session store, no memory.
- **Captcha is part of the contract.** IDS escalates captcha by egress IP. `ids_login` returns an image + encrypted `continuation` instead of retrying; never auto-retry a failed login.

Full layering, platform/sub-app/tool model and migration plan: `docs/ARCHITECTURE.md`.
Tool-surface rules (naming, budgets, schemas, outputs, annotations, error classes) are normative in **`docs/MCP-TOOL-CONVENTIONS.md`** and enforced by `pnpm check:surface`. Read it before adding or renaming a tool. Keep code aligned with it (one module per platform, tools hold schemas, platforms hold parsing).

## Key Directories

| Path | Purpose |
|---|---|
| `app/api/mcp/route.ts` | The only MCP entry point; route segment config (`runtime`, `maxDuration`, `dynamic`). |
| `app/page.tsx`, `app/layout.tsx` | Minimal landing page (endpoint URL, tool list, connector snippet). |
| `lib/mcp/server.ts` | `registerCampusTools(server)` — every tool definition lives here. |
| `lib/mcp/auth.ts` | `withBearerAuth()` — static-token gate for the MCP endpoint. |
| `lib/campus/ids-auth.ts` | Password login: page parsing, `encryptPassword` (AES-128-CBC port of site JS), manual cookie jar, error-code mapping, service-ticket minting. |
| `lib/campus/ids.ts` | CAS URLs + p3/serviceValidate ticket redemption (server-to-server). |
| `lib/campus/seal.ts` | AES-256-GCM sealing of session handles (`seal`/`unseal`, 12 h TTL enforced on open). |
| `lib/campus/http.ts` | Shared cookie jar + `follow()` (manual redirects, per-hop `Set-Cookie`). |
| `lib/campus/eams.ts`, `egate.ts` | Platform adapters ported from `/home/zambar/repos/shanghaitech-cpdaily-auth` (TechPie backend). |
| `lib/campus/catalog.ts` | Campus capability catalog: entry points (title/description/url/keywords/tool). `searchCatalog()` is local keyword+bigram scoring — **no network, no LLM**. EAMS URLs were scraped from the live menu `home!childmenus.action?menu.id=165/176`; every entry must be verified, never guessed. |
| `lib/campus/print.ts` | 校园文印 (`PRINT_BASE_URL`, 默认 `http://10.15.21.225`). **Not CAS** — own account system with the same username/password; token obtained at `ids_login` time and kept as platform `print` (JWT ~7d). Upload: `POST /v1/task/pending/uploadPrintFile?source=web`, header `x-token`, multipart field **`file`** → `{uuid, printCode}`. Delete: `DELETE /v1/task/pending/deleteTaskByIds` body `{"uuids":[…]}` (eventually consistent — the list lags a moment). Host is campus-LAN only; CORS reflects Origin and allows `X-Token`, so a browser/client on campus can POST directly without proxying bytes. |
| `lib/campus/elrc.ts` | 在线课堂 (ELRC). 课程搜索用专用接口 `GET /learn/shanghai/tech/get/course?keyword=&page=&size=&sort=semester`（跨所有学期，约 1.1 万门；`semester_show_name` 形如 `2026-2027-1`，需转成 `2026-2027学年秋季`）。其他范围：`/rman/v1/resourcecentre/searchteachingresource`（教学资源，source=EYun|Blackboard|Mooc）、`/learn/v1/search/history/knowledge/point`、`/search/live`、`/search/teacher`。`/learn/search` 的 SSR 内嵌 JSON 只是页面回退，不再使用。个人课程列表用 `/learn/v1/learningsituation/teaching/course/get/participated/courses/list?courseType=2&semester=<2026-2027学年秋季>`，教务详情走 `/shanghaitechdatasync/datasync/bksCourse/?semester=&term=&course_no=<CS181.01>&course_id=<CS181>` 的 `extend_message`（`JwPkKcxxBk_instance` 学分/学时、`jxdg_instance` 教学大纲、`CourseDocking_instance`+`eyun_course` 关联平台与 eCourse 链接、`bksCourseTimeTable` 上课安排）。 CAS client of IDS: `/unifiedlogin/v1/loginmanage/login/direction?redirect_url=…` → IDS → `/unifiedlogin/v1/cas/login`. Data: `/learn/v1/course/video/review/-1` (list), `recording/video/info` (weeks+videos), `POST /rman/v1/search/new/relation/videos` (per-session clips → `contentId_`), `keywordAndAbstract?videoId=` (AI abstract+keywords), `intelligent/select/knowledge/summary?contentId=` (AI sections), `POST /rman/v1/smart/voice/select` (transcript), `entity/file/screenshot?contentId=` (slides+OCR). **All times are .NET ticks (100 ns) — divide by 1e7.** |
| `lib/campus/elearning.ts` | Blackboard Learn (`:8443`). Login: IDS → elearning SSO form → POST `/webapps/bb-sso-BBLEARN/execute/authValidate/customLogin` → an auto-submit form (`timestamp`/`sign`) → `/webapps/portal/execute/tabs/tabAction`. Cookies `session_id`/`s_session_id`. Data: `/webapps/calendar/calendarData/allCourseEvents` (deadlines), `announcement?context=course|myorganization`, `listContent.jsp` (folders + `/bbcswebdav/` files). |
| `lib/campus/ecourse.ts` | TronClass. SPA + Keycloak CAS broker: `ecourse/login → ecourse:8600/auth/realms/shanghaitech/protocol/cas → IDS CAS`; session is `session=V2-…` plus `KEYCLOAK_*` cookies. API: `/api/my-courses`, `/api/courses/{id}/activities`, `/api/courses/{id}/exams`, `/api/course/{id}/enrollments`, `/api/uploads/{id}/url` (signed, Range-capable). |
| `lib/campus/libspace.ts` | Library-space booking. Different credential shape: IDS **OAuth2 code** → `access_token`, sent as header `token:` (not `Authorization: Bearer`). Derived per call; no cookie session. |
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
- **Tools are auto-indexed.** Every tool goes through `defineTool(server, …)` (`lib/mcp/registry.ts`), which records name/title/description for `campus_find`. Never register with `server.registerTool` directly — the drift check in `pnpm check:surface` fails if a tool is missing from the find index.
- **Not every feature becomes a tool.** Data-bearing features are wrapped; everything else is a catalog entry surfaced by `campus_find` / `eams_menu` (title + link + whether an MCP tool exists). Prefer "tell the student where to click" over scraping a page nobody asked to automate.
- **Tool surface is governed** by `docs/MCP-TOOL-CONVENTIONS.md`: names `<platform>_<resource>_<verb>` (2–5 segments), ≤25 tools total / ≤6 per platform, every input field described, writes require a `confirm` gate plus explicit `destructiveHint`, failures return `isError` with the next action, never credentials. Verify with `pnpm check:surface` (needs a running server).
- **User-facing strings are Chinese** (tool descriptions, error messages, page copy). Code comments and identifiers are English.
- **Async/errors**: `async` handlers, `AbortSignal.timeout(...)` on every outbound fetch, explicit `res.ok` checks, typed error classes per platform. No silent `catch {}`; convert to a user-visible result or rethrow with context.
- **Env access** only at module scope or in the function that owns it, always with a default (`process.env.X ?? "https://…"`); secrets never logged, never in tool arguments unless the tool's job is to accept credentials (`ids_login`).
- **Session handles**: tools never take a raw cookie; they take the sealed handle from `ids_login` and call `unseal()` first. Never add a module-level `Map` cache for sessions.
- **Next.js route config**: `runtime = "nodejs"` (edge deprecated), `maxDuration = 300`, `dynamic = "force-dynamic"`. Do not add `basePath`/`sseEndpoint`-style options — removed in `mcp-handler` 2.x.

## Important Files

- `app/api/mcp/route.ts` — entry point; the export shape (`GET`/`POST`) is the API contract.
- `lib/mcp/server.ts` — single source of truth for exposed tools.
- `lib/mcp/auth.ts` — authentication seam.
- `lib/campus/ids.ts` — CAS wire facts (`/authserver/login`, `/authserver/p3/serviceValidate?format=JSON`). Treat these paths and behaviours as verified production facts.
- `.env.example` — every supported env var: `MCP_AUTH_TOKEN`, `MCP_ENC_KEY` (required by `ids_login`), `IDS_BASE_URL`, `COURSEBENCH_BASE_URL`, `PUBLIC_BASE_URL`.
- `next.config.ts`, `tsconfig.json`, `package.json` — nothing exotic; keep them boring.

## Runtime/Tooling Preferences

- **Node.js ≥ 20.9** (Vercel Node runtime), **pnpm** (`pnpm-lock.yaml` is the lockfile of record), Next.js 16 App Router.
- Pinned versions that are known-good together: `next@16.4.6`, `react@19.3.1`, `mcp-handler@2.3.1`, `@modelcontextprotocol/server@2.4.0` (v2 SDK, spec 2026-07-28 + 2025-era stateless fallback), `zod@4.6.7`, `typescript@7.0.2`.
- Do **not** introduce `@modelcontextprotocol/sdk` (v1 maintenance line), `@vercel/mcp-adapter` (superseded), `@vercel/kv` (sunset) or the 2024-11-05 HTTP+SSE transport.
- No stdio transport in this repo: Vercel functions are per-request. Local stdio access, if ever needed, is `mcp-remote` on the client side.
- Region: `hkg1` for China latency. Hobby caps: 300 s `maxDuration`, 1 WAF rate-limit rule — plan rate limiting in code (`@upstash/ratelimit`) rather than relying on WAF.

## Local network caveat

Campus hosts are reached **through the machine's HTTP proxy** in this environment (`HTTPS_PROXY`). Node's fetch ignores it unless the process starts with `NODE_OPTIONS=--use-env-proxy` (Node ≥24). Without it every campus call fails with `fetch failed (ETIMEDOUT)`. Vercel has direct egress, so no flag is needed there.

## Testing & QA

- No unit-test framework yet. Gates before pushing: `pnpm lint` (tsc) and `pnpm build`, then `scripts/smoke-mcp.sh` against a running build.
- Manual protocol verification uses the MCP Inspector (`pnpm mcp:inspect`) or the `curl` snippet above; a real client (Claude/Cursor) is the final check for auth/connector behaviour.
- Platform adapters can be smoke-tested without credentials: run a `.ts` probe with `bun` (Node's type stripping cannot resolve extensionless relative imports) passing `{CASTGC: "TGT-fake"}`; the expected result is `CampusSessionExpired`.
- `ids_login` smoke test uses a **non-existent** student id (e.g. `0000000000`) with any password: the expected, verified result is `登录失败（bad_credentials）：用户名或密码错误`. A success there would mean the mock is wrong; a `session_expired` error means the AES port or cookie jar broke.
- When platform clients grow logic (parsing, retries, credential derivation), add `vitest` and test the pure functions (`averageScore`, ticket-response parsing, error-string classification). Do not write tests that only assert a fetch was called.
- Never test campus flows with real credentials from CI. Captcha escalation on IDS is keyed to **egress IP**; repeated failed logins from one host poison captcha state for every user behind that IP.
