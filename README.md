# shanghaitech-mcp

上海科技大学校园 MCP 服务器。一个部署在 Vercel 上的 MCP 端点，通过校园统一身份认证（IDS）确认「你是哪个学生」，然后把各校园平台的能力封装成 MCP 工具。

## 现状

| 部分 | 状态 |
|---|---|
| MCP 端点（Streamable HTTP，`/api/mcp`） | ✅ 可用，MCP 2026-07-28 + 2025-era stateless 双协议 |
| CourseBench 课程搜索 / 详情 / 点评（公开数据） | ✅ 可用 |
| IDS 用户名+密码登录（`ids_login`，换 12 小时 session 句柄） | ✅ 可用（含验证码两段式） |
| IDS 票据校验 / service ticket 换取 | ✅ `lib/campus/ids.ts`、`lib/campus/ids-auth.ts` |
| 静态 bearer token 兜底（IDE/CI） | ✅ `MCP_AUTH_TOKEN` |

## 为什么是 Next.js + Vercel

结论：**可以，而且是最省事的选择**，但必须接受三条硬约束：

1. **没有 stdio**。Vercel Function 是每请求执行，MCP 只能走 Streamable HTTP。
2. **没有跨请求内存**。`mcp-handler@2` 因此完全无状态（协议本身在 2026-07-28 起也取消了 session），需要跨调用保留的东西必须放进 Postgres/Redis，并以「显式句柄参数」的形式交给工具。
3. **单次调用 ≤ 300s（Hobby）**，长任务要拆成「提交任务 → 返回 id → 轮询」。

技术上等价方案还有 Hono（`@modelcontextprotocol/hono`）或独立 Express；选 Next.js 是因为这个项目还需要 OAuth 授权页、同意页、`/.well-known/*` 元数据和一个简单首页，放在同一个 App Router 应用里最直接。

### 认证方式：直接输入 IDS 学号 + 密码

不做自建 OAuth。`ids_login` 工具收 `username` + `password`，服务端按 IDS 页面的真实协议完成登录，返回一个不透明 `session` 句柄；后续校园工具只认这个句柄。**密码只用于当次请求，不落库**；句柄用 `MCP_ENC_KEY` 做 AES-256-GCM 密封，12 小时过期，本身等价于登录态。

实测登录链（2026-11-11，抓包 + 站内 `encrypt.js` 静态分析）：

```
GET  /authserver/login?service=<svc>          # 取 #pwdEncryptSalt(16字符) / #execution / #lt
GET  /authserver/checkNeedCaptcha.htl?username=…   # {"isNeed":bool}
GET  /authserver/getCaptcha.htl               # 需要时，JPEG，绑定 JSESSIONID
POST /authserver/login?service=<svc>
     username, password=<AES输出>, captcha, _eventId=submit,
     cllt=userNameLogin, dllt=generalLogin, lt, execution
  → 302 <svc>?ticket=ST-…       成功（并下发 CASTGC）
  → 302 /authserver/login        失败，错误文案在重定向后的页面里
```

密码密文 = `base64(AES-128-CBC(key=utf8(盐), iv=utf8(随机16), data=utf8(随机64)+密码, PKCS7))`。

两个坑已在代码里处理：`Set-Cookie` 畸形（重复 `secure` + 空值 cookie，普通 cookie jar 会丢掉 `JSESSIONID`，必须手工收集/回放）；验证码按**出口 IP** 升级，所以 `ids_login` 从不盲目重试——需要验证码时返回图片 + `continuation`，由人看清后带上重试。

## 本地开发

```bash
pnpm install
cp .env.example .env.local
pnpm dev                 # http://localhost:3000
```

环境变量至少要有 `MCP_ENC_KEY`（`openssl rand -base64 32`），否则 `ids_login` 会明确报错。

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

1. **会话 → 平台适配器**：用 `session` 里的 `CASTGC` 换 EAMS、eGate、eCourse 的 service ticket，封装为 `eams_*`、`egate_*`、`ecourse_*` 工具。
2. **限速与熔断**：按 IP + 学号限流 `ids_login`；连续失败要停手（验证码是按出口 IP 升级的，盲目重试会连累同一 IP 的所有人）。
3. **托管客户端**：claude.ai / ChatGPT 不支持自定义 header，要么走 OAuth（本次明确不做），要么只支持 IDE/CLI 客户端。
4. **测试**：`encryptPassword`、错误码分类、`seal/unseal` 上 `vitest`；登录链只用无效学号做冒烟，不用真实凭据跑 CI。

## 已知边界

- 邮件（Coremail，强制二次验证）、图书馆（Primo VE，自有 apikey）、OJ（Hydro）、VPN（Sangfor aTrust）不走 IDS SSO，需要单独适配。
- Blackboard / Gradescope / 体育馆预约等只有校内可达，直接从 Vercel 访问会失败。
