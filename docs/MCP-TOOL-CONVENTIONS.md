# MCP 工具面规范

适用范围：本仓库所有通过 `server.registerTool` 暴露给模型的能力。规则分三级：

- **MUST** —— `scripts/check-tool-surface.ts` 会检查，违反即 CI 失败。
- **SHOULD** —— 检查器给 warning，人评审时判断。
- **MAY** —— 建议做法。

## 1. 发现模型：模型看到什么

客户端把 `tools/list` 的结果注入上下文，模型据此选工具。因此**每个工具的 `name` + `title` + `description` + `inputSchema` 都是常驻成本**。

| 机制 | 何时用 | 本仓库约定 |
|---|---|---|
| `tools/list` | 可执行动作 | 唯一入口，全部工具在此 |
| `outputSchema` + `structuredContent` | 返回结构化数据的工具 | MUST（纯写操作回执类除外） |
| `annotations` | 让客户端决定是否弹确认 | MUST：`readOnlyHint` 必填；写操作 `destructiveHint: true` |
| `resources` | 静态文档/长表格 | SHOULD：平台使用说明、字典表放这里，不进工具列表 |
| `prompts` | 带参数的固定流程（用户主动选） | MAY：如「约明早研习室」 |
| `notifications/tools/list_changed` | 工具集动态变化 | 不用：本仓库工具集编译期固定 |

`server/discover`（协议 2026-07-28）与 `tools/list` 的缓存提示由 `mcp-handler` 自动处理，不要手写。

## 2. 命名

```
<platform>_<resource|subapp>_<verb>[_<qualifier>]
```

- **MUST** 匹配 `^[a-z][a-z0-9]*(_[a-z0-9]+)+$`，段数 2–5。
- **MUST** 首段是平台 id（`coursebench` / `eams` / `egate` / `libspace` / `oa` / `elearning` / `campus`）或认证域 `ids`。
- **MUST** 末段是动词：`get` / `list` / `search` / `query` / `create` / `do` / `status`。
  - 读：`*_get`、`*_list`、`*_search`、`*_query`
  - 写：`*_create`、`*_do`、`*_action`（多动作合一，动作名做参数）
- **MUST NOT** 把参数塞进名字（`eams_course_table_for_semester_123`）。
- 重命名是破坏性变更：旧名保留并标 `deprecated` 至少一个版本。

## 3. 粒度与预算

- **MUST** 全站工具 ≤ 40 个；单平台 ≤ 6 个。（25 → 30 → 35 → 40：随平台增加，工具面约 6k tokens；再涨就要改用 `campus_find` + 参数化聚合。）
- **MUST NOT** 出现万能 SQL 式工具（`campus_query(sql)`）；模型无法可靠构造，schema 校验也失效。
- **MUST NOT** 每个字段一个工具。
- 超预算时：先加 `campus_platforms` 索引（返回平台/能力/工具名，纯本地，不触网），再把静态说明移到 `resources`。
- 同一平台的多个写动作合并为一个 `*_action` 工具（`action` 用 enum），避免 `cancel_reservation` / `sign_in` / … 各占一个。

## 4. 输入 schema

- **MUST** 用 `z.object({...})`（v2 SDK 的 Standard Schema），不要裸 `{}`。
- **MUST** 每个字段有 `.describe()`，中文，写清单位/格式/取值范围（如 `date: YYYY-MM-DD`）。
- **MUST** 能用 enum 就不要用 free-form string（`space_type`、`action`）。
- **MUST** 列表类工具带 `limit`（默认 ≤20，上限 ≤100）和分页语义（`page` 或 `cursor`）。
- **MUST** 写操作带 `confirm: z.boolean().default(false)`；未带 `confirm: true` 时**只回显将要发生的事**，不提交。
- **MUST NOT** 要求调用方传 cookie / token / 原始会话；只接受 `session`（`ids_login` 的密封句柄）。
- **SHOULD** 时间、日期、ID 用正则或 `int().positive()` 约束，别把校验留给平台。

## 5. 输出

- **MUST** 返回 `{ content: [{ type: "text", text }] }`；有结构化数据时同时给 `structuredContent` + `outputSchema`。
- **MUST** `text` 第一行是可读摘要（一句话），细节在后续行；**MUST NOT** 把整页 HTML/原始 JSON 灌进 context。
- **MUST** 列表输出带总数（`共 N 条（显示 M）`）与截断提示。
- **MUST** 失败返回 `isError: true`，文案是**下一步动作**（「重新 ids_login」），不是堆栈。
- 写操作 **MUST** 原样返回平台回执（`raw`），这些系统没有幂等语义，回执是唯一真相。
- **MUST NOT** 在输出里回显凭据、cookie、token、session 句柄。

## 6. 错误分类（唯一允许的六种语义）

| 类 | 触发 | 文案 |
|---|---|---|
| `CredentialError` | 密码/验证码错误 | 「凭据错误，请重新输入」 |
| `CaptchaRequired` | `isNeed=true` | 图片 + continuation |
| `CampusSessionExpired` | 落回 ids / 正文含「统一身份认证」/ cookie 缺失 | 「重新 ids_login」 |
| `UpstreamError` | 5xx / 超时 / 非预期状态码 | 带状态码与 URL 路径 |
| `ParseDriftError` | 结构不符 | 带 title / 字节数 |
| `Unsupported` | 平台确实没有该能力 | 明说不支持 |

平台适配器负责把上游错误映射到这六类；工具层只负责把类映射成 `isError` + 文案。

## 7. annotations

```ts
annotations: { readOnlyHint: true, openWorldHint: true }                          // 读
annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } // 创建类写
annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }  // 取消/删除/多动作
```

- **MUST** 显式写 `readOnlyHint`；写操作 **MUST** 显式写 `destructiveHint`（创建类可以是 `false`，`cancel`/`delete`/`*_action` 类必须是 `true`）。默认值不可依赖。
- 不要用 annotations 代替确认门：客户端对 `destructiveHint` 的处理不一致，`confirm` 才是硬约束。

## 8. 新增一个工具的清单

1. 平台适配器里加函数，返回 typed 数据或抛六类错误之一；**工具文件不写 `fetch`**。
2. 命名符合 §2；检查预算（§3）。
3. `title`（中文短名）、`description`（动作 + 参数含义 + 是否写操作）、`inputSchema`（每个字段 describe）。
4. `outputSchema`（数据类）+ `structuredContent`。
5. `annotations`（§7）。
6. 写操作：`confirm` 门 + 回执透传 + `destructiveHint`。
7. `pnpm check:surface` 通过（见 §9）。
8. 本地起服务，用真实句柄跑一次最小成功路径，把输出贴进 PR 描述。

## 9. 自动检查

```bash
pnpm dev            # 或 next start
pnpm check:surface  # 默认 http://127.0.0.1:3000/api/mcp，可传 URL 与 token
```

检查项：命名正则与段数、全站/单平台预算、`title`/`description` 存在与长度、`readOnlyHint` 显式、写操作含 `confirm`、`inputSchema` 每个字段有 description、数据类工具是否有 `outputSchema`（warning）、描述里是否标了写操作（warning）。

CI 里把它挂在 build 之后，服务用 `next start` 起在 3000。
