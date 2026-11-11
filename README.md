# shanghaitech-mcp

上海科技大学校园 MCP 服务器。一个部署在 Vercel 上的 MCP 端点，通过校园统一身份认证（IDS）确认「你是哪个学生」，然后把各校园平台的能力封装成 MCP 工具。

## 现状

| 部分 | 状态 |
|---|---|
| MCP 端点（Streamable HTTP，`/api/mcp`） | ✅ 可用，MCP 2026-07-28 + 2025-era stateless 双协议 |
| CourseBench 课程搜索 / 详情 / 点评（公开数据） | ✅ 可用 |
| IDS（CAS）票据校验工具函数 | ✅ `lib/campus/ids.ts` |
| 按用户的 OAuth 2.1（IDS 作为上游登录后端） | ⬜ 未实现，见「路线图」 |
| 静态 bearer token 兜底（IDE/CI） | ✅ `MCP_AUTH_TOKEN` |

## 为什么是 Next.js + Vercel

结论：**可以，而且是最省事的选择**，但必须接受三条硬约束：

1. **没有 stdio**。Vercel Function 是每请求执行，MCP 只能走 Streamable HTTP。
2. **没有跨请求内存**。`mcp-handler@2` 因此完全无状态（协议本身在 2026-07-28 起也取消了 session），需要跨调用保留的东西必须放进 Postgres/Redis，并以「显式句柄参数」的形式交给工具。
3. **单次调用 ≤ 300s（Hobby）**，长任务要拆成「提交任务 → 返回 id → 轮询」。

技术上等价方案还有 Hono（`@modelcontextprotocol/hono`）或独立 Express；选 Next.js 是因为这个项目还需要 OAuth 授权页、同意页、`/.well-known/*` 元数据和一个简单首页，放在同一个 App Router 应用里最直接。

### 认证不能靠「用户名密码登录」

IDS 是金智（Wisedu）统一身份认证，在 `/authserver/*` 下实现 Apereo CAS 协议，**没有 OIDC 发现**。实测结论：

- 密码登录需要模拟站内 `encrypt.js` 的 AES、绑定 `JSESSIONID`、并把同一次登录的多跳请求压在一个 Function 里；
- captcha 是**按出口 IP 升级**的（连续失败后同 IP 的所有用户名都要验证码），Vercel 共享出口 IP 会互相拖累；
- 短信/扫码/Passkey 三种二次验证随时可能被用户开启。

所以认证走浏览器委托：`/authorize` → 302 到 `ids…/authserver/login?service=<我们的回调>` → 回调拿 `ticket` → `p3/serviceValidate?format=JSON` 校验 → 我们自己签发 JWT。**永远不收集校园密码。**

## 本地开发

```bash
pnpm install
cp .env.example .env.local
pnpm dev                 # http://localhost:3000
```

MCP 协议自检：

```bash
./scripts/smoke-mcp.sh http://localhost:3000/api/mcp
# 或
npx @modelcontextprotocol/inspector
#   transport: Streamable HTTP
#   url: http://localhost:3000/api/mcp
```

质量门：

```bash
pnpm lint    # tsc --noEmit
pnpm build
```

## 部署到 Vercel

```bash
vercel link
vercel env add MCP_AUTH_TOKEN production   # openssl rand -hex 32
vercel --prod
```

建议 region 选 `hkg1`。生产环境必须设置 `MCP_AUTH_TOKEN`，否则 `/api/mcp` 对公网开放。

## 客户端接入

IDE / CLI（Cursor、Claude Code、Codex …）：

```json
{
  "mcpServers": {
    "shanghaitech": {
      "type": "http",
      "url": "https://<deployment>/api/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

claude.ai / ChatGPT 这类托管客户端不支持自定义 header，需要等 OAuth 2.1 那一步（见下）。

## 路线图

1. **OAuth 2.1 授权服务器 + IDS 委托登录**
   - `/.well-known/oauth-protected-resource`（RFC 9728）、`/.well-known/oauth-authorization-server`（RFC 8414）
   - `/oauth2/authorize`（同意页 + CAS 跳转）、`/oauth2/token`（PKCE，轮换 refresh token）
   - CIMD 优先、DCR 兜底；`aud` = MCP 端点 URL，禁止 token 透传
   - 存储：Neon Postgres（授权记录）+ Upstash Redis（限速/事务）
2. **会话 → 平台适配器**：用 `CASTGC` / 服务票据派生 EAMS、eGate、eCourse 会话，封装为 `eams_*`、`egate_*`、`ecourse_*` 工具。
3. **限速与熔断**：按 `sub` + `ip` 双维度限流；对 IDS 全局熔断，避免把 MCP 用户变成 CAS 登录风暴。
4. **测试**：平台客户端的纯函数（票据解析、错误码分类、重试）上 `vitest`。

## 已知边界

- 邮件（Coremail，强制二次验证）、图书馆（Primo VE，自有 apikey）、OJ（Hydro）、VPN（Sangfor aTrust）不走 IDS SSO，需要单独适配。
- Blackboard / Gradescope / 体育馆预约等只有校内可达，直接从 Vercel 访问会失败。
