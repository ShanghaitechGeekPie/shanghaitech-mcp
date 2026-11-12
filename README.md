# shanghaitech-mcp

上海科技大学校园 MCP 服务器。一个部署在 Vercel 上的 MCP 端点，通过校园统一身份认证（IDS）确认「你是哪个学生」，然后把各校园平台的能力封装成 MCP 工具。

## 现状

| 部分 | 状态 |
|---|---|
| MCP 端点（Streamable HTTP，`/api/mcp`） | ✅ 可用，MCP 2026-07-28 + 2025-era stateless 双协议 |
| CourseBench 课程搜索 / 详情 / 点评（公开数据） | ✅ 可用 |
| IDS 用户名+密码登录（`ids_login`，换 12 小时 session 句柄） | ✅ 可用（含验证码两段式） |
| IDS 票据校验 / service ticket 换取 | ✅ `lib/campus/ids.ts`、`lib/campus/ids-auth.ts` |
| 一个 CASTGC 换多平台会话（EAMS / eGate） | ✅ `lib/campus/{http,eams,egate}.ts` |
| EAMS 身份 / 学期 / 考试排考 | ✅ 工具 `eams_profile`、`eams_semesters`、`eams_exams` |
| eGate 学生信息 | ✅ 工具 `egate_student` |
| 图书馆空间预约（libspace） | ✅ 6 个工具：账号 / 查房间 / 查时段 / 我的预约 / 创建 / 签到·取消·提前结束·延长 |
| Blackboard（elearning） | ✅ 5 个工具：课程 / 通知公告 / 作业与截止 / 课件目录 / 课件下载（代理链接） |
| ELRC 在线课堂 | ✅ 6 个工具：课程搜索（全学期）/ 我的课程 / 课程详情（大纲·安排·关联平台）/ 全局搜索（资源·知识点·直播·教师）/ AI 概览 / 语音转写 / 课件截图 |
| 文印系统（校园内网） | ✅ 2 个工具：上传文档（取件码）/ 待输出作业列表·删除 |
| 校园功能目录 | ✅ `campus_find`（工具 + 网页入口统一检索） |
| eCourse（TronClass） | ✅ 6 个工具：课程 / 作业与截止 / 在线测验 / 同班同学 / 课件 / 课件下载 |
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

### 平台会话链（一个 TGC 换多个平台）

`ids_login` 拿到的 CASTGC 是根凭证。每个平台只要用**它自己的入口 URL** 打一次带 `CASTGC` 的请求，目标站点会自己 302 到 IDS 拿 service ticket，再 302 回来种下自己的会话 cookie：

```
CASTGC ──GET <平台入口 URL>──▶ 302 ids…/authserver/login?service=<平台自己生成的>
       ◀──302 <平台>?ticket=ST-…──  （消费票据）
       ◀──200 + Set-Cookie: JSESSIONID / MOD_AUTH_CAS──▶ 平台会话
```

关键点（踩过的坑）：

- **不用硬编码 `service=`**：EAMS（Spring CAS filter）和 eGate（`mod_auth_cas`）都会在 302 里生成自己的 service，照着重定向走就行；OA 的入口 URL 自带 `workflowid` 查询串，也是同理。
- **必须手工跟重定向**：JavaScript `fetch` 的 `redirect: "follow"` 拿不到中间跳的 `Set-Cookie`。`lib/campus/http.ts` 的 `follow()` 逐跳收集 cookie。
- **每个平台都有「预热」**：EAMS 要先 `home.action`，否则 `courseTableForStd.action` 只回一个空壳；eGate 要先打 `getAppConfig/xshdapp-…do`，否则 `MOD_AUTH_CAS` 不刷新。
- **失效判定**：最终 URL 落在 `ids…` 或正文出现「统一身份认证」就是会话死了，重新 `ids_login`，不要盲目重试（消费过的 ticket 重放必失败）。

已实现：EAMS（身份 + 学期列表）、eGate（学生信息）、libspace（图书馆空间预约全套）。

libspace 是第三种会话形态，验证了体系的可扩展性：它是 **IDS OAuth2 授权码**而不是 cookie 会话——

```
GET /spaceReservationApp/api/login            → 302 IDS oauth2.0/authorize（client_id 已注册）
    → 302 ids…/authserver/login?service=…     （CASTGC 有效则直接过）
    → 302 libspace…/login?code=…&state=…
GET /spaceReservationApp/api/callBack?code&state → {"access_token":"AT-…","expires_in":28800}
此后每个请求带 header：token: <AT-…>        （不是 Authorization: Bearer）
```

所以平台层只需要多一种「凭证类型」（token 而非 cookie），`ids_login` 的 session 句柄、seal、错误分类全部复用。参考实现是 `shanghaitech-cpdaily-auth`（TechPie 后端），EAMS/eGate 逐行对照移植；libspace 为实测逆向（前端 bundle + 抓包）。

## 本地开发

```bash
pnpm install
cp .env.example .env.local
pnpm dev                 # http://localhost:3000
# 本机若要走代理出网（eCourse/EAMS 等校园域名）：NODE_OPTIONS=--use-env-proxy pnpm dev
```

环境变量至少要有 `MCP_ENC_KEY`（`openssl rand -base64 32`），否则 `ids_login` 会明确报错。生产还需要 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`（会话两级缓存；本地缺失时退化为进程内 Map）。

`ids_login` 支持 `lang: "zh_CN" | "en"`：IDS 会记住登录时的语言，**EAMS 页面随之显示中文/英文**（实测：英文登录 → EAMS 英文；中文登录 → EAMS 中文，考试类型显示「期中考试」）。不传则沿用账号当前设置。

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

## Docker

```bash
docker build -t shanghaitech-mcp .
docker run -p 3000:3000 \
  -e MCP_ENC_KEY="$(openssl rand -base64 32)" \
  -e MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  shanghaitech-mcp
```

镜像基于 Next.js standalone 输出（`node server.js`），约 380MB，非 root 用户运行；密钥全部走运行时环境变量，不烘进镜像。

GitHub Actions（`.github/workflows/docker.yml`）：push 到 `main` / `v*` tag 时构建并推送到 GHCR（`ghcr.io/<owner>/shanghaitech-mcp`），PR 只构建 + 跑一次 `tools/list` 冒烟，不推送。

```bash
docker pull ghcr.io/hezebang/shanghaitech-mcp:latest
```

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

## 两种交付形态

不是所有校园功能都值得包装成工具。本仓库的取舍：

- **能稳定拿数据的**（课表之外的作业/考试/课件/空间预约）→ 做成工具；
- **其余一律只做入口**：`campus_find` 给出「去哪个链接看、需不需要登录、有没有已封装工具」。例如「成绩排名获取」「电子成绩单」「培养方案」都是 EAMS 里的一个页面，学生自己点进去看即可；
- 搜索会**跨平台**返回：问「考试」同时给 EAMS 排考与 eCourse 在线测验；问「座位」同时给 libspace 与图书馆。
- `campus_find` 的索引是**运行时自动生成**的：每个工具注册时都会登记 name/title/description（`lib/mcp/registry.ts`），所以搜「作业」能直接命中 `ecourse_assignments`，不存在手抄一份元数据的问题；`pnpm check:surface` 会校验「每个工具都能被 find 找到」。

## 工具面规范

命名、预算（全站 ≤25 / 单平台 ≤6）、schema、输出、annotations、错误分类：见 [`docs/MCP-TOOL-CONVENTIONS.md`](docs/MCP-TOOL-CONVENTIONS.md)。加工具后跑：

```bash
pnpm dev &            # 或 next start
pnpm check:surface    # 默认 http://127.0.0.1:3000/api/mcp
```

## 架构

分层、四级模型（协议族/平台/子应用/工具）、工具命名与预算、会话与错误分类：见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 已知边界

- 邮件（Coremail，强制二次验证）、图书馆（Primo VE，自有 apikey）、OJ（Hydro）、VPN（Sangfor aTrust）不走 IDS SSO，需要单独适配。
- Blackboard / Gradescope / 体育馆预约等只有校内可达，直接从 Vercel 访问会失败。

## License

MIT © ShanghaiTech GeekPie
