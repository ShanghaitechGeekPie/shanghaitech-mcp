import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CourseBenchError,
  averageScore,
  getCourse,
  getCourseComments,
  searchCourses,
  type CourseSummary,
} from "@/lib/campus/coursebench";
import { CampusSessionExpired, deriveEamsSession, eamsProfile, eamsSemesters } from "@/lib/campus/eams";
import { deriveEgateSession, egateStudent } from "@/lib/campus/egate";
import {
  LibspaceError,
  createReservation,
  extendOptions,
  listRooms,
  libspaceSession,
  me as libspaceMe,
  reservationAction,
  reservation as libspaceReservation,
  reservations as libspaceReservations,
  schedule as libspaceSchedule,
  spaceConfig,
  searchUsers,
  type SpaceType,
} from "@/lib/campus/libspace";
import { login, mintServiceTicket, type CookieJar } from "@/lib/campus/ids-auth";
import { seal, unseal } from "@/lib/campus/seal";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CONTINUATION_TTL_MS = 10 * 60 * 1000;

interface IdsSessionToken {
  userId: string;
  cookies: CookieJar;
  service: string;
}

interface CaptchaContinuation {
  cookies: CookieJar;
  service: string;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function courseLine(c: CourseSummary): string {
  const avg = averageScore(c.score ?? []);
  return [
    `#${c.id}`,
    c.code || "-",
    c.name,
    c.institute || "-",
    `${c.credit} 学分`,
    avg === null ? "暂无评分" : `均分 ${avg.toFixed(2)}`,
    `${c.comment_num} 条点评`,
  ].join(" | ");
}

/** One sealed handle in, one platform AuthContext out — tools never see the credential shape. */
async function platformAuth<T extends object>(
  session: string,
  derive: (root: CookieJar) => Promise<T>,
): Promise<T> {
  return derive(unseal<IdsSessionToken>(session).cookies);
}

function campusFailure(prefix: string, cause: unknown) {
  const err = cause instanceof Error ? cause : undefined;
  const nested = err?.cause instanceof Error ? ` (${err.cause.message})` : "";
  const message =
    cause instanceof CampusSessionExpired || cause instanceof LibspaceError
      ? `${cause.message}${nested}`
      : `${err?.message ?? String(cause)}${nested}`;
  return { content: [{ type: "text" as const, text: `${prefix}：${message}` }], isError: true };
}

function groupSlots(slots: Array<{ time: string; statusCode: string }>): string {
  const merged: Array<{ start: string; end: string; code: string }> = [];
  for (const slot of slots) {
    const last = merged[merged.length - 1];
    if (last && last.code === slot.statusCode) last.end = slot.time;
    else merged.push({ start: slot.time, end: slot.time, code: slot.statusCode });
  }
  const label: Record<string, string> = { AVAILABLE: "空闲", OCCUPIED: "已占用", CLOSED: "未开放" };
  return merged.map((m) => `${m.start}-${m.end} ${label[m.code] ?? m.code}`).join("；");
}

function failure(cause: unknown) {
  const message = cause instanceof CourseBenchError ? cause.message : (cause as Error)?.message ?? String(cause);
  return { content: [{ type: "text" as const, text: `调用 CourseBench 失败：${message}` }], isError: true };
}

/**
 * Registers every tool this server exposes. Called once per MCP request by
 * `createMcpHandler` (the v2 SDK is stateless by construction).
 */
export function registerCampusTools(server: McpServer): void {
  server.registerTool(
    "coursebench_search_courses",
    {
      title: "搜索课程评价",
      description:
        "搜索上海科技大学课程评价（CourseBench 公开数据，无需登录）。按关键词/开课单位/最低均分过滤，返回课程 id、课程号、名称、学分、均分和点评数。",
      inputSchema: z.object({
        query: z.string().min(1).optional().describe("课程名或课程号关键词，如“木工”“CS100”"),
        institute: z.string().min(1).optional().describe("开课单位子串，如“信息学院”“上道书院”"),
        min_score: z.number().min(0).max(5).optional().describe("最低均分（0-5）"),
        limit: z.number().int().min(1).max(50).default(20).describe("最多返回条数"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, institute, min_score, limit }) => {
      try {
        const courses = await searchCourses({ query, institute, minScore: min_score, limit });
        if (courses.length === 0) return text("没有匹配的课程。");
        const header = `找到 ${courses.length} 门课程：`;
        return text([header, ...courses.map(courseLine)].join("\n"));
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "coursebench_course_detail",
    {
      title: "课程详情（含教师分组）",
      description: "按课程 id 获取课程详情：各开课分组的教师、分组均分与点评数。",
      inputSchema: z.object({
        course_id: z.number().int().positive().describe("coursebench_search_courses 返回的课程 id"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course_id }) => {
      try {
        const course = await getCourse(course_id);
        const lines = [courseLine(course)];
        for (const group of course.groups ?? []) {
          const avg = averageScore(group.score ?? []);
          const teachers = (group.teachers ?? []).map((t) => `${t.name}#${t.id}`).join("、") || "-";
          lines.push(
            `  分组 ${group.id}: 教师 ${teachers} | ${avg === null ? "暂无评分" : `均分 ${avg.toFixed(2)}`} | ${group.comment_num} 条点评`,
          );
        }
        return text(lines.join("\n"));
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "coursebench_course_comments",
    {
      title: "课程点评",
      description: "获取某门课程的公开点评文本（长点评会在 800 字处截断）。",
      inputSchema: z.object({
        course_id: z.number().int().positive().describe("课程 id"),
        limit: z.number().int().min(1).max(20).default(5).describe("最多返回条数"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course_id, limit }) => {
      try {
        const comments = await getCourseComments(course_id, limit);
        if (comments.length === 0) return text("该课程暂无点评。");
        const body = comments
          .map((c, i) => {
            const content = c.content.length > 800 ? `${c.content.slice(0, 800)}…` : c.content;
            return `${i + 1}. ${c.title}\n${content}`;
          })
          .join("\n\n");
        return text(body);
      } catch (cause) {
        return failure(cause);
      }
    },
  );

  server.registerTool(
    "ids_login",
    {
      title: "IDS 登录（用户名 + 密码）",
      description:
        "用上海科技大学统一身份认证（IDS）的学号/工号和密码登录，换取一个不透明的 session 句柄供后续校园工具使用。" +
        "凭据只用于这一次请求，服务端不保存密码；session 句柄本身等价于登录态，请当作密码保管。" +
        "注意：凭据会出现在 MCP 客户端的历史记录里。" +
        "如果 IDS 要求验证码，本工具会返回验证码图片和一个 continuation，用户看清后带 captcha + continuation 重试。",
      inputSchema: z.object({
        username: z.string().min(1).max(64).describe("学号或工号"),
        password: z.string().min(1).max(128).describe("IDS 密码"),
        captcha: z.string().max(16).optional().describe("验证码（仅在返回 captcha_required 后需要）"),
        continuation: z
          .string()
          .optional()
          .describe("上一次 captcha_required 返回的续做句柄，必须与 captcha 一起提交"),
        service: z
          .string()
          .url()
          .optional()
          .describe("要换取票据的 service URL，默认 IDS 个人中心；通常不需要改"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ username, password, captcha, continuation, service }) => {
      let jar: CookieJar | undefined;
      if (continuation) {
        try {
          jar = unseal<CaptchaContinuation>(continuation).cookies;
        } catch {
          return { content: [{ type: "text" as const, text: "continuation 已过期，请重新发起 ids_login。" }], isError: true };
        }
      }

      try {
        const outcome = await login({ username, password, captcha, service, jar });

        if (outcome.kind === "captcha_required") {
          const token = seal<CaptchaContinuation>({ cookies: outcome.cookies, service: outcome.service }, CONTINUATION_TTL_MS);
          return {
            content: [
              { type: "image" as const, data: outcome.captcha.data, mimeType: outcome.captcha.mimeType },
              {
                type: "text" as const,
                text:
                  "IDS 要求验证码。请让用户查看这张图片，然后调用 ids_login 时带上 captcha 和 continuation：\n" +
                  `continuation=${token}`,
              },
            ],
          };
        }

        if (outcome.kind === "failed") {
          return {
            content: [{ type: "text" as const, text: `登录失败（${outcome.code}）：${outcome.message}` }],
            isError: true,
          };
        }

        const session = seal<IdsSessionToken>(
          { userId: outcome.userId, cookies: outcome.cookies, service: outcome.service },
          SESSION_TTL_MS,
        );
        const cookies = Object.keys(outcome.cookies).sort().join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text:
                `登录成功：${outcome.userId}\n` +
                `session（12 小时内有效，等价于登录态）：\n${session}\n` +
                `已获得的 cookie：${cookies}`,
            },
          ],
        };
      } catch (cause) {
        return { content: [{ type: "text" as const, text: `IDS 登录异常：${(cause as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "ids_status",
    {
      title: "检查 IDS 登录态",
      description: "用已有 session 向 IDS 换一次 service ticket，验证登录态是否仍然有效。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session }) => {
      let token: IdsSessionToken & { exp: number };
      try {
        token = unseal<IdsSessionToken>(session);
      } catch (cause) {
        return { content: [{ type: "text" as const, text: `session 无效：${(cause as Error).message}` }], isError: true };
      }
      const probe = "https://ids.shanghaitech.edu.cn/authserver/index.do";
      const ticket = await mintServiceTicket(token.cookies, probe);
      const expires = new Date(token.exp).toISOString();
      return text(
        ticket
          ? `有效：${token.userId}，句柄 ${expires} 到期；已成功换取 service ticket。`
          : `已失效：${token.userId}，请重新 ids_login。`,
      );
    },
  );

  server.registerTool(
    "eams_profile",
    {
      title: "EAMS 身份（验证会话）",
      description:
        "用 ids_login 的 session 走一遍 CAS 票据链登录教务系统（EAMS），返回姓名与学号。用于确认会话是否可用。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session }) => {
      let cookies: CookieJar;
      try {
        cookies = unseal<IdsSessionToken>(session).cookies;
      } catch (cause) {
        return { content: [{ type: "text" as const, text: `session 无效：${(cause as Error).message}` }], isError: true };
      }
      try {
        const profile = await eamsProfile(await deriveEamsSession(cookies));
        return text(`EAMS 会话可用：${profile.name ?? "姓名未知"}（学号 ${profile.studentId ?? "未知"}）`);
      } catch (cause) {
        const message = cause instanceof CampusSessionExpired ? cause.message : (cause as Error).message;
        return { content: [{ type: "text" as const, text: `EAMS 登录失败：${message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "eams_semesters",
    {
      title: "EAMS 学期列表",
      description: "列出教务系统可选学期及其 id（后续查询课表/考试需要），并标出默认学期。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session }) => {
      let cookies: CookieJar;
      try {
        cookies = unseal<IdsSessionToken>(session).cookies;
      } catch (cause) {
        return { content: [{ type: "text" as const, text: `session 无效：${(cause as Error).message}` }], isError: true };
      }
      try {
        const result = await eamsSemesters(await deriveEamsSession(cookies));
        const lines = result.semesters.map(
          (s) => `${s.id === result.defaultSemester ? "★ " : "  "}${s.year} ${s.name} (id=${s.id})`,
        );
        return text([`共 ${result.semesters.length} 个学期：`, ...lines].join("\n"));
      } catch (cause) {
        const message = cause instanceof CampusSessionExpired ? cause.message : (cause as Error).message;
        return { content: [{ type: "text" as const, text: `EAMS 查询失败：${message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "egate_student",
    {
      title: "eGate 学生信息（第二个平台）",
      description:
        "用同一个 ids_login session 走 mod_auth_cas 网关登录 eGate 服务大厅，返回学号/姓名。用于验证「一个 CASTGC 换多个平台会话」的链路。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session }) => {
      let cookies: CookieJar;
      try {
        cookies = unseal<IdsSessionToken>(session).cookies;
      } catch (cause) {
        return { content: [{ type: "text" as const, text: `session 无效：${(cause as Error).message}` }], isError: true };
      }
      try {
        const student = await egateStudent(await deriveEgateSession(cookies));
        return text(`eGate 会话可用：学号 ${student.studentId ?? "未知"}`);
      } catch (cause) {
        const message = cause instanceof CampusSessionExpired ? cause.message : (cause as Error).message;
        return { content: [{ type: "text" as const, text: `eGate 登录失败：${message}` }], isError: true };
      }
    },
  );

  // ---------------------------------------------------------------- libspace

  server.registerTool(
    "libspace_me",
    {
      title: "图书馆空间预约 · 我的账号",
      description:
        "查看 libspace（图书馆讨论室/研习室/静音舱预约）的账号信息：学号、姓名、邮箱，以及各空间类型的违约/黑名单状态。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session }) => {
      try {
        const profile = await libspaceMe(await platformAuth(session, libspaceSession));
        const violations = (profile.violationCountList ?? [])
          .map((v) => {
            const type = typeof v.reservationType === "string" ? v.reservationType : "?";
            const count = typeof v.violationCount === "number" ? v.violationCount : "?";
            const black = v.blacklisted === true ? "（黑名单）" : "";
            return `${type}: 违约 ${count}${black}`;
          })
          .join("；");
        return text(
          [
            `${profile.userName}（${profile.userNo}）${profile.userType ? ` · ${profile.userType}` : ""}`,
            profile.email ? `邮箱 ${profile.email}` : "",
            violations ? `记录：${violations}` : "无违约记录",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (cause) {
        return campusFailure("libspace 账号查询失败", cause);
      }
    },
  );

  server.registerTool(
    "libspace_spaces",
    {
      title: "图书馆空间 · 按日期查可预约房间",
      description:
        "查询某天可预约的讨论室/个人研习室/静音舱，返回每间房的空闲时段数。可选按空间类型、楼层过滤。日期格式 YYYY-MM-DD，可预约窗口受 cycleDays 限制。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("预约日期 YYYY-MM-DD"),
        type: z
          .enum(["DISCUSSION_ROOM", "STUDY_ROOM", "SILENT_BOOTH"])
          .optional()
          .describe("空间类型：讨论室 / 个人研习室 / 静音舱；省略则查全部"),
        floor: z.number().int().min(1).optional().describe("楼层（1 起），省略则不限"),
        limit: z.number().int().min(1).max(100).default(40).describe("最多返回房间数"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, date, type, floor, limit }) => {
      try {
        const auth = await platformAuth(session, libspaceSession);
        const rooms = (await listRooms(auth, { date, type, pageSize: 100 })).filter(
          (r) => floor === undefined || r.floorNo === floor,
        );
        if (rooms.length === 0) return text(`${date} 没有符合条件的房间。`);

        const header = type
          ? await spaceConfig(auth, type)
              .then(
                (c) =>
                  `${type} 开放 ${c.openStartTime}-${c.openEndTime}，单次 ${c.minDurationHours}-${c.maxDurationHours} 小时，可预约未来 ${c.cycleDays} 天`,
              )
              .catch(() => "")
          : "（未指定类型，已合并讨论室/研习室/静音舱）";

        const lines = rooms.slice(0, limit).map((room) => {
          const slots = room.slots ?? [];
          const free = slots.filter((s) => s.statusCode === "AVAILABLE").length;
          const meta = [
            room.floorNo !== null && room.floorNo !== undefined ? `${room.floorNo}F` : "",
            room.capacity ? `${room.capacity}人` : "",
            room.equipment?.length ? room.equipment.join("/") : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return `#${room.id} ${room.spaceName}${meta ? ` | ${meta}` : ""} | 空闲 ${free}/${slots.length} 段`;
        });
        return text([header, `共 ${rooms.length} 间（显示 ${lines.length}）：`, ...lines].filter(Boolean).join("\n"));
      } catch (cause) {
        return campusFailure("libspace 房间查询失败", cause);
      }
    },
  );

  server.registerTool(
    "libspace_schedule",
    {
      title: "图书馆空间 · 单房间时段",
      description: "查询单个空间某天的时段占用情况，按连续状态合并输出（空闲/已占用/未开放）。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        space_id: z.number().int().positive().describe("空间 id（libspace_spaces 返回的 #id）"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("日期 YYYY-MM-DD"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, space_id, date }) => {
      try {
        const detail = await libspaceSchedule(await platformAuth(session, libspaceSession), space_id, date);
        return text(`${detail.date} 空间 #${detail.spaceId}：\n${groupSlots(detail.slots)}`);
      } catch (cause) {
        return campusFailure("libspace 时段查询失败", cause);
      }
    },
  );

  server.registerTool(
    "libspace_reservations",
    {
      title: "图书馆空间 · 我的预约",
      description:
        "列出我的预约（当前 current / 历史 history），或按 reservation_id 查看单条详情（附可延长选项）。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        reservation_id: z.number().int().positive().optional().describe("只看这一条预约的详情"),
        tab: z.enum(["current", "history"]).default("current").describe("current=当前预约，history=历史记录"),
        space_type: z.enum(["DISCUSSION_ROOM", "STUDY_ROOM", "SILENT_BOOTH"]).optional().describe("按空间类型过滤"),
        room_name: z.string().optional().describe("按空间名称过滤"),
        status: z.string().optional().describe("按状态码过滤，如 WAIT_SIGN / IN_USE / DONE"),
        date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("起始日期（需与 date_end 同时给出）"),
        date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("结束日期"),
        limit: z.number().int().min(1).max(50).default(10).describe("最多返回条数"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, reservation_id, tab, space_type, room_name, status, date_start, date_end, limit }) => {
      try {
        const auth = await platformAuth(session, libspaceSession);
        if (reservation_id) {
          const detail = await libspaceReservation(auth, reservation_id);
          const options = await extendOptions(auth, reservation_id, detail.endTime).catch(() => null);
          const lines = [
            `#${detail.reservationId} ${detail.spaceName} | ${detail.reserveDate} ${detail.startTime}-${detail.endTime}`,
            `状态：${detail.reservationStatusStr ?? detail.reservationStatus}${detail.signInWindow ? "（当前可签到）" : ""}${
              detail.canExtend ? "，可延长" : ""
            }`,
            detail.meetingTopic ? `主题：${detail.meetingTopic}` : "",
            detail.participantsName ? `参与人：${detail.participantsName}` : "",
            options && options.allow
              ? `可延长 ${options.maxExtendTimes ?? 0} 次，已延长 ${options.currentExtendTimes ?? 0} 次，选项：${JSON.stringify(options.options ?? [])}`
              : options
                ? "当前不可延长"
                : "",
          ];
          return text(lines.filter(Boolean).join("\n"));
        }

        const page = await libspaceReservations(auth, {
          tab,
          pageNo: 1,
          pageSize: limit,
          type: space_type,
          roomName: room_name,
          statusCode: status,
          dateStart: date_start,
          dateEnd: date_end,
        });
        if (page.list.length === 0) return text(`${tab === "current" ? "当前没有进行中的预约。" : "没有历史预约。"}`);
        const lines = page.list.map(
          (r) =>
            `#${r.reservationId} ${r.reserveDate} ${r.startTime}-${r.endTime} ${r.spaceName} | ${
              r.reservationStatusStr ?? r.reservationStatus
            }${r.canExtend ? " | 可延长" : ""}${r.signInWindow ? " | 可签到" : ""}`,
        );
        return text([`共 ${page.total ?? lines.length} 条（显示 ${lines.length}）：`, ...lines].join("\n"));
      } catch (cause) {
        return campusFailure("libspace 预约查询失败", cause);
      }
    },
  );

  server.registerTool(
    "libspace_reserve",
    {
      title: "图书馆空间 · 创建预约（写）",
      description:
        "创建空间预约。必须先不带 confirm 调用一次核对可用性，确认返回的摘要无误后，带 confirm: true 再调用才会真正提交。时间按 30 分钟粒度，需在开放时段内且满足最短/最长时长。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        space_id: z.number().int().positive().describe("空间 id"),
        space_type: z.enum(["DISCUSSION_ROOM", "STUDY_ROOM", "SILENT_BOOTH"]).describe("空间类型（与空间 id 对应）"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("预约日期"),
        start_time: z.string().regex(/^\d{2}:\d{2}$/).describe("开始时间 HH:MM"),
        end_time: z.string().regex(/^\d{2}:\d{2}$/).describe("结束时间 HH:MM"),
        title: z.string().max(60).optional().describe("会议/用途主题（讨论室）"),
        meeting_type: z.enum(["INTERNAL_MEETING", "EXTERNAL_MEETING"]).optional().describe("会议类型（讨论室）"),
        inviter_keywords: z.array(z.string().min(1)).max(10).optional().describe("参与人姓名关键词，按姓名检索后加入邀请"),
        confirm: z.boolean().default(false).describe("true 才真正提交；第一次调用请留空以核对"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ session, space_id, space_type, date, start_time, end_time, title, meeting_type, inviter_keywords, confirm }) => {
      try {
        const auth = await platformAuth(session, libspaceSession);
        const [detail, config] = await Promise.all([libspaceSchedule(auth, space_id, date), spaceConfig(auth, space_type)]);

        const wants = detail.slots.filter((s) => s.time >= start_time && s.time < end_time);
        const blocked = wants.filter((s) => s.statusCode !== "AVAILABLE");
        if (wants.length === 0) return text(`时间段 ${start_time}-${end_time} 不在 ${date} 的时段表内。`);

        const minutes =
          Number(end_time.slice(0, 2)) * 60 + Number(end_time.slice(3)) - (Number(start_time.slice(0, 2)) * 60 + Number(start_time.slice(3)));
        const problems = [
          blocked.length > 0 ? `${blocked.length} 个时段不可用（${blocked.map((s) => s.time).join(",")}）` : "",
          minutes < config.minDurationHours * 60 ? `时长不足 ${config.minDurationHours} 小时` : "",
          minutes > config.maxDurationHours * 60 ? `超过单次上限 ${config.maxDurationHours} 小时` : "",
          start_time < config.openStartTime || end_time > config.openEndTime
            ? `超出开放时间 ${config.openStartTime}-${config.openEndTime}`
            : "",
        ].filter(Boolean);

        const inviters: Array<{ inviterName: string; inviterNo: string }> = [];
        for (const keyword of inviter_keywords ?? []) {
          const found = await searchUsers(auth, keyword);
          const exact = found.find((u) => u.userName === keyword) ?? found[0];
          if (!exact) problems.push(`找不到参与人「${keyword}」`);
          else inviters.push({ inviterName: exact.userName, inviterNo: exact.userNo });
        }

        const summary = [
          `预约 #${space_id} 于 ${date} ${start_time}-${end_time}（${minutes} 分钟）`,
          inviters.length ? `邀请：${inviters.map((i) => `${i.inviterName}(${i.inviterNo})`).join("、")}` : "",
          problems.length ? `问题：${problems.join("；")}` : "校验通过",
        ].filter(Boolean);

        if (problems.length > 0) return { content: [{ type: "text" as const, text: summary.join("\n") }], isError: true };
        if (!confirm) return text([...summary, "未提交。确认无误后带 confirm: true 重新调用。"].join("\n"));

        const receipt = await createReservation(auth, {
          spaceId: space_id,
          spaceType: space_type,
          dates: [date],
          startTime: start_time,
          endTime: end_time,
          meetingType: meeting_type,
          title,
          inviterList: inviters,
        });
        return text(`已提交，平台回执：${receipt}`);
      } catch (cause) {
        return campusFailure("libspace 预约失败", cause);
      }
    },
  );

  server.registerTool(
    "libspace_reservation_action",
    {
      title: "图书馆空间 · 签到/取消/提前结束/延长（写）",
      description:
        "对一条预约执行动作：sign-in 签到、cancel 取消、end-early 提前结束、extend 延长（需 hours）。不带 confirm 时只回显将执行的动作。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        reservation_id: z.number().int().positive().describe("预约 id"),
        action: z.enum(["sign-in", "cancel", "end-early", "extend"]).describe("动作"),
        hours: z.number().positive().max(8).optional().describe("extend 必填：延长的课时数"),
        confirm: z.boolean().default(false).describe("true 才真正提交"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ session, reservation_id, action, hours, confirm }) => {
      if (action === "extend" && !hours) {
        return { content: [{ type: "text" as const, text: "extend 需要 hours 参数（延长课时数）。" }], isError: true };
      }
      const label = { "sign-in": "签到", cancel: "取消预约", "end-early": "提前结束", extend: `延长 ${hours ?? "?"} 小时` }[action];
      if (!confirm) {
        return text(`将对预约 #${reservation_id} 执行：${label}。确认后带 confirm: true 重新调用。`);
      }
      try {
        const auth = await platformAuth(session, libspaceSession);
        const receipt = await reservationAction(auth, reservation_id, action, { hours });
        return text(`已执行${label}，平台回执：${receipt}`);
      } catch (cause) {
        return campusFailure(`libspace ${label}失败`, cause);
      }
    },
  );
}
