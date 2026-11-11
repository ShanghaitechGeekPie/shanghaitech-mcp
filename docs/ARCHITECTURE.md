# 架构蓝图

目标：把「一个 CASTGC + 一堆校园平台」变成可长期维护的工具面，而不是每加一个平台就往 `server.ts` 里塞一段 if。

## 0. 硬约束（决定了后面所有设计）

| 约束 | 后果 |
|---|---|
| Vercel Function 每请求执行 | 没有跨请求内存、没有后台任务、单次 ≤300s |
| 不建数据库（当前决策） | 状态只能放在**调用方持有的不透明句柄**里 |
| 校园系统是「登录态 + cookie」而不是 OAuth | 所有会话都是 cookie jar 的派生，必须能重放与失效判定 |
| 平台接口形态各异 | 必须有「协议族」抽象，否则每个平台一套私有逻辑 |
| 模型要选工具 | 工具数量与命名直接决定可用性，不能无限膨胀 |

## 1. 分层

```
MCP transport        app/api/mcp/route.ts        auth (bearer) + 协议协商
      │
工具层 tools/         campus_platforms, eams_schedule_get, …
      │              zod schema / 输出格式 / 错误→isError
      │
会话层 session/       handle ↔ cookie jar、派生缓存、续期、失效语义
      │
平台层 platforms/<family>/<platform>/
      │              family: cas | wisedu | spring-eams | weaver | blackboard | public-rest
      │
传输层 platforms/http/   cookie jar、逐跳重定向、超时、UA、错误归一
```

调用链（读操作）：

```
tool(args, ctx)
  → ctx.session(handle)                   解开 seal → 根 cookie（CASTGC）
  → registry.platform(id).derive(rootJar) 幂等：已有缓存则复用
  → platform.call(...)                    fetch + 解析
  → 平台返回「未登录」 → CampusSessionExpired → 工具输出可执行的下一步
```

写操作多一步：`confirm` 参数 + `destructiveHint` + 幂等键。

## 2. 四级模型

设计要表达的其实是四个层级，别混在一起：

| 层 | 例子 | 职责 |
|---|---|---|
| **协议族 family** | `cas`、`wisedu-xsfw`、`spring-action`、`weaver`、`blackboard`、`public-rest` | 传输/解析范式，全项目复用 |
| **平台 platform** | `eams`、`egate`、`oa`、`elearning`、`coursebench` | 一个域名/一套会话 |
| **子应用 sub-app** | eGate 下的 `xshdapp`（活动签到）、`tycg`（体育场馆）；EAMS 下的课表/考试/成绩 | 一个平台内的独立入口，各有自己的 bootstrap |
| **工具 tool** | `egate_xshdapp_sign_list`、`eams_schedule_get` | 模型可调用的最小单元 |

关键洞察：Wisedu 系平台里「子应用」是数据而不是代码——`xsfw/sys/<appCode>/...` + 一个 `getAppConfig/<configId>` 预热。所以子应用应该是**一张表**，不是一批文件。

```ts
// platforms/wisedu/apps.ts
export interface WiseduApp {
  id: string;              // "xshdapp"
  title: string;           // "活动签到"
  configId: string;        // "xshdapp-4770201649822494"
  entry: string;           // "/xsfw/sys/xshdapp/xshdApply/dxnxxqgrhz.do"
  probe: (jar: CookieJar) => Promise<string>;   // 最便宜的「登录成功」证据
}
```

EAMS 的子模块同理：`schedule / exam / grade / plan`，共享一个 Spring session，差异只在 endpoint 和解析器。

## 3. 目录蓝图

```
app/api/mcp/route.ts             唯一入口（route segment config 不变）
lib/
  mcp/
    server.ts                    registerAll(server) —— 不含业务逻辑
    auth.ts                      可选 bearer 门
    result.ts                    ok()/fail()/json()/table() 输出助手
    errors.ts                    CampusError 家族 + 到 MCP 的映射
  session/
    seal.ts                      AES-256-GCM 句柄（已有）
    context.ts                   ToolContext：resolve(handle) → 根 jar
    cache.ts                     进程内 LRU（尽力而为，正确性不依赖它）
  platforms/
    registry.ts                  平台注册表（id → adapter + capabilities）
    http.ts                      cookie jar + follow()（已有）
    cas/                         ids-auth.ts、tickets.ts（已有 + 拆出 mint）
    eams/{index,client,parsers}.ts
    wisedu/{client,apps}.ts       xsfw 族 + 子应用表
    weaver/gym.ts
    blackboard/client.ts
    coursebench/client.ts        （现 campus-coursebench）
  tools/
    index.ts                     registerAll()
    campus.ts                    campus_platforms / campus_help
    coursebench.ts  eams.ts  egate.ts  oa.ts  blackboard.ts
```

规则：**工具文件里没有 `fetch`，平台文件里没有 zod schema**。schema 属于工具面，解析属于平台面。

## 4. 核心接口

```ts
// platforms/registry.ts
export interface Platform {
  id: string;
  title: string;
  auth: "public" | "castgc" | "password";
  /** 用根 cookie 换本平台 cookie；幂等。 */
  derive?: (root: CookieJar) => Promise<CookieJar>;
  /** 最便宜的存活探针；失败即视为会话失效。 */
  probe?: (jar: CookieJar) => Promise<void>;
  capabilities: string[];          // ["schedule.read", "exam.read"]
}
```

```ts
// platforms/http.ts —— 平台之间的唯一凭证差异被收在这一层
export interface AuthContext {
  headers: Record<string, string>;   // token / authorization 型平台
  jar?: CookieJar;                   // cookie 型平台
}
export const cookieAuth = (jar: CookieJar): AuthContext => ({ headers: {}, jar });
export const headerAuth = (headers: Record<string, string>): AuthContext => ({ headers });
export function authOptions(ctx: AuthContext, extra?: FollowOptions): FollowOptions;
```

```ts
// session/context.ts
export interface ToolContext {
  root(handle: string): CookieJar;                 // 解 seal，校验 exp
  platform(id: string, handle: string): Promise<CookieJar>;  // derive + 缓存
  user(handle: string): { userId: string } ;
}
```

`platform()` 的内部顺序固定：缓存命中 → 否则 `derive` → `probe` → 写缓存 → 返回。缓存键 `hash(CASTGC)+platformId`，TTL 10min（对齐参考实现的派生周期），命中失败时只允许**一次**静默重派生，第二次失败就报 `CampusSessionExpired`。

## 5. 工具面设计

### 命名

```
<platform>_<subapp|resource>_<verb>[_<qualifier>]
eams_schedule_get        eams_exam_list        eams_grade_list
egate_xshdapp_sign_list  egate_xshdapp_sign_do
oa_gym_slot_query        oa_gym_book_do
coursebench_course_search
```

- 动词只用 `get/list/search/query/do`（`do` 仅写操作）。
- 平台内的资源层级最多两段，避免 `eams_schedule_current_week_course_list` 这类面条名。
- 改名视为破坏性变更：保留旧名并标 `deprecated`，至少一个版本。

### 粒度

| 反模式 | 原因 |
|---|---|
| 一个 `campus_query(sqlish)` 万能工具 | 模型无法可靠构造参数，校验也失效 |
| 每个字段一个工具 | 工具列表爆炸，选错率高 |
| 一个平台 20+ 工具 | 同上 |

预算：**单平台 ≤6 个工具，全站 ≤25 个**。超了就加 `campus_platforms`（能力索引）+ 按子应用分组，而不是继续堆。

### 发现与帮助

- `campus_platforms`：返回平台、能力、所需认证、以及每个能力对应的工具名（纯本地，不触网）。
- `campus_help{platform?}`：用法示例（含典型参数），模型在不确定时调用。
- 这两个工具的成本是「一次列表渲染」，比让模型在 25 个工具里瞎猜便宜。

### 输出

```ts
return ok({ summary: "张三 / 2023000000", data: profile });  // text + structuredContent
```

- 有 `outputSchema` 的工具返回 `structuredContent`；`text` 只放人类可读摘要 + 关键字段，避免把整页 HTML 灌进上下文。
- 列表统一 `limit`（默认 20，上限 50）+ `cursor`（平台支持分页时）+ `truncated: true` 标记。
- 解析失败抛 `ParseDriftError(url, title, bytes)`，绝不返回「两者皆 null」的静默结果。

### 写操作

```ts
oa_gym_book_do({ date, slot, venue, confirm: true, idempotency_key })
```

- `annotations: { destructiveHint: true, readOnlyHint: false }`
- 必须带 `confirm: true`，缺省拒绝并返回「将执行什么」的摘要。
- 返回平台的原始回执（`raw`）——这些系统没有幂等语义，回执是唯一真相。

## 6. 会话与凭据

```
ids_login(username,password[,captcha]) → { session }        12h，seal 保护
  session = { userId, cookies:{CASTGC}, exp }
tool(session) → ctx.platform("eams", session) → derive → 本平台 jar
```

- **密码永不落库**，也不进缓存；只在 `ids_login` 的那一次请求里存在。
- 句柄是 bearer 级凭据：日志、错误信息、`structuredContent` 里都不能出现。
- 多用户阶段（若以后要做）唯一要换的是 `session/context.ts` 的 `root()`：从「解 seal」换成「查 OAuth 换来的 grant」。工具层不动。
- 分支：若以后加数据库，`platform()` 的缓存换成 Redis，键不变。

## 7. 错误分类（必须收敛，否则工具面全是字符串）

| 类 | 触发 | 工具输出 |
|---|---|---|
| `CredentialError` | IDS 返回密码错误/验证码错误 | 「凭据错误，请重新输入」+ 不重试 |
| `CaptchaRequired` | `isNeed=true` | 图片 + continuation |
| `CampusSessionExpired` | 落回 ids / 正文含「统一身份认证」/ MOD_AUTH_CAS 缺失 | 「重新 ids_login」 |
| `UpstreamError` | 5xx、超时、非预期状态码 | 原样带上状态码与 URL 路径 |
| `ParseDriftError` | HTML/JSON 结构与解析器不符 | 带 title/字节数/页面片段长度，便于定位 |
| `Unsupported` | 平台确实没有该能力（如 eCourse 无服务端流程） | 明说「不支持」，不装作失败 |

映射：全部 `isError: true`，`text` 是**下一步可执行动作**，不是堆栈。

## 8. 子入口与「必须开浏览器」的平台

三类，处理方式不同：

1. **纯 API**（EAMS 数据查询、eGate JSON、CourseBench）：直接调。
2. **要人操作的写操作**（选课、预约、签到）：工具负责「准备 + 校验 + 提交」，提交前必须回显将要发生的事；失败返回原始回执。
3. **只能浏览器完成的流程**（eCourse/TronClass 的 Keycloak broker、需要扫码/2FA 的场景）：

```ts
campus_link({ session, target: "ecourse" }) → { url, expires_in }
```

服务端用 CASTGC 现换一张一次性 service ticket，拼成 `…?ticket=ST-…` 的深链返回；用户在浏览器打开即完成 SSO，**不把 CASTGC 交出去**。若某平台连这个都不行，就登记为 `auth: "unsupported"`，工具直接返回「请在网页端操作」，不硬凑。

## 9. 安全与限速

- `ids_login` 是唯一收密码的入口：按 `ip + username` 双键限流（5 次/15 分钟），失败后指数退避；验证码是出口 IP 级的，重试会连累同 IP 的所有人。
- 只读工具默认 `readOnlyHint: true`；写工具单独列白名单，日志里记录参数摘要（不含凭据）。
- 出站请求固定超时（10–15s）、固定 UA、禁用重定向自动跟随（必须逐跳收 cookie）。
- 响应体上限（如 2 MB），超限按 `ParseDriftError` 处理而不是截断后硬解析。

## 10. 测试

| 层 | 方式 |
|---|---|
| 解析器（HTML/JS 字面量/JSON 信封） | fixture 驱动：`test/fixtures/eams/stdDetail.zh.html`、`.en.html`、`egate/hqdlxsjpcxx.json`；改了站点就换 fixture |
| 会话派生 | 负路径可离线跑：伪造 CASTGC 断言 `CampusSessionExpired`（`bun` 直接跑 .ts） |
| 工具面 | 起本地服务 + 真句柄，冒烟 `tools/list` 与每个工具的最小成功路径 |
| 写操作 | 只用手动/沙箱账号，不进 CI |

## 11. 从当前代码迁移（机械步骤）

1. `lib/campus/*` → `lib/platforms/*`；`http.ts`、`seal.ts` 分别进 `platforms/`、`session/`。
2. `lib/mcp/server.ts` 拆成 `tools/index.ts` + 每平台一个工具文件；`registerTool` 全部换成 `defineTool(spec)`。
3. 引入 `registry.ts`，把 EAMS/eGate 的 `derive`/`probe` 挂进去；`unseal → ctx.platform(id)` 替换现有两处手工派生。
4. eGate 的 `xshdapp` 常量搬进 `wisedu/apps.ts`，为后续 `tycg` 等子应用留位。
5. `campus_platforms` / `campus_help` 先落地（纯本地，零风险），再逐个补工具。
6. `outputSchema` 逐步补到数据类工具上。

## 12. 能力矩阵（现状 / 计划）

| 平台 | 协议族 | 认证 | 会话证据 | 工具 |
|---|---|---|---|---|
| CourseBench | public-rest | 无 | — | `coursebench_*` ✅ |
| EAMS | spring-action | CASTGC | `stdDetail` 姓名 + 学号 | `eams_profile`、`eams_semesters`、`eams_exams` ✅；课表/成绩 ⬜ |
| eGate | wisedu-xsfw | CASTGC | `MOD_AUTH_CAS` + `hqdlxsjpcxx.XSBH` | `egate_student` ✅；活动签到/服务大厅 ⬜ |
| OA 体育馆 | weaver | CASTGC | `shkjdx_session` | ⬜（查询 → 预约，写操作） |
| elearning | blackboard | CASTGC + 二次表单 | `session_id` | ⬜（日程/作业） |
| libspace | oauth2-code → bearer | CASTGC（换 OAuth code） | `access_token` + `/me` | `libspace_*` ✅（含写操作） |
| eCourse | keycloak-broker | CASTGC（CAS broker） | `session=V2-…` + `KEYCLOAK_*` | `ecourse_*` ✅（课程/作业/在线测验/同学/课件/下载） |
| eCourse | keycloak-broker | CASTGC（浏览器） | 无服务端流程 | ⬜（深链 / `campus_link`） |
| 图书馆 / 邮件 / OJ | 自有账号 | 非 IDS | — | 明确标 unsupported，不承诺 SSO |
