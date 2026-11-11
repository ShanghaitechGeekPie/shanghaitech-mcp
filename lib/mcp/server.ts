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
import { CampusSessionExpired, deriveEamsSession, eamsExams, eamsProfile, eamsSemesters } from "@/lib/campus/eams";
import {
  EcourseError,
  deriveEcourseSession,
  listActivities,
  listCourses,
  listEnrollments,
  listExams,
  uploadInfo,
  uploadUrl,
} from "@/lib/campus/ecourse";
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

/** Text summary for humans + machine-checkable payload for the client. */
function structured<T extends Record<string, unknown>>(summary: string, data: T) {
  return { content: [{ type: "text" as const, text: summary }], structuredContent: data };
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

async function ecourseAuth(session: string) {
  return platformAuth(session, deriveEcourseSession);
}

function formatDeadline(iso: string | null | undefined): string {
  if (!iso) return "无截止";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function campusFailure(prefix: string, cause: unknown) {
  const err = cause instanceof Error ? cause : undefined;
  const nested = err?.cause instanceof Error ? ` (${err.cause.message})` : "";
  const message =
    cause instanceof CampusSessionExpired || cause instanceof LibspaceError || cause instanceof EcourseError
      ? `${cause.message}${nested}`
      : `${err?.message ?? String(cause)}${nested}`;
  return { content: [{ type: "text" as const, text: `${prefix}：${message}` }], isError: true };
}

const SLOT_LABEL: Record<string, string> = { AVAILABLE: "空闲", OCCUPIED: "已占用", CLOSED: "未开放" };

function mergeSegments(slots: Array<{ time: string; statusCode: string }>): Array<{ start: string; end: string; statusCode: string }> {
  const merged: Array<{ start: string; end: string; statusCode: string }> = [];
  for (const slot of slots) {
    const last = merged[merged.length - 1];
    if (last && last.statusCode === slot.statusCode) last.end = slot.time;
    else merged.push({ start: slot.time, end: slot.time, statusCode: slot.statusCode });
  }
  return merged;
}

function formatSegments(segments: Array<{ start: string; end: string; statusCode: string }>): string {
  return segments.map((m) => `${m.start}-${m.end} ${SLOT_LABEL[m.statusCode] ?? m.statusCode}`).join("；");
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
      outputSchema: z.object({
        count: z.number(),
        courses: z.array(
          z.object({
            id: z.number(),
            name: z.string(),
            code: z.string(),
            institute: z.string(),
            credit: z.number(),
            avgScore: z.number().nullable(),
            commentNum: z.number(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, institute, min_score, limit }) => {
      try {
        const courses = await searchCourses({ query, institute, minScore: min_score, limit });
        if (courses.length === 0) return text("没有匹配的课程。");
        return structured([`找到 ${courses.length} 门课程：`, ...courses.map(courseLine)].join("\n"), {
          count: courses.length,
          courses: courses.map((c) => ({
            id: c.id,
            name: c.name,
            code: c.code ?? "",
            institute: c.institute ?? "",
            credit: c.credit,
            avgScore: averageScore(c.score ?? []),
            commentNum: c.comment_num,
          })),
        });
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
      outputSchema: z.object({
        course: z.object({
          id: z.number(),
          name: z.string(),
          code: z.string(),
          institute: z.string(),
          credit: z.number(),
          avgScore: z.number().nullable(),
          commentNum: z.number(),
        }),
        groups: z.array(
          z.object({
            id: z.number(),
            teachers: z.array(z.object({ id: z.number(), name: z.string() })),
            avgScore: z.number().nullable(),
            commentNum: z.number(),
          }),
        ),
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
        return structured(lines.join("\n"), {
          course: {
            id: course.id,
            name: course.name,
            code: course.code ?? "",
            institute: course.institute ?? "",
            credit: course.credit,
            avgScore: averageScore(course.score ?? []),
            commentNum: course.comment_num,
          },
          groups: (course.groups ?? []).map((g) => ({
            id: g.id,
            teachers: (g.teachers ?? []).map((t) => ({ id: t.id, name: t.name })),
            avgScore: averageScore(g.score ?? []),
            commentNum: g.comment_num,
          })),
        });
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
      outputSchema: z.object({
        count: z.number(),
        comments: z.array(z.object({ id: z.number(), title: z.string(), content: z.string() })),
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
        return structured(body, {
          count: comments.length,
          comments: comments.map((c) => ({ id: c.id, title: c.title, content: c.content })),
        });
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
        lang: z
          .enum(["zh_CN", "en"])
          .optional()
          .describe("登录语言：IDS 会记住该设置，之后 EAMS 页面随之显示中文/英文。省略则沿用账号当前设置"),
      }),
      outputSchema: z.object({
        status: z.enum(["ok", "captcha_required"]),
        userId: z.string().optional(),
        session: z.string().optional(),
        continuation: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ username, password, captcha, continuation, service, lang }) => {
      let jar: CookieJar | undefined;
      if (continuation) {
        try {
          jar = unseal<CaptchaContinuation>(continuation).cookies;
        } catch {
          return { content: [{ type: "text" as const, text: "continuation 已过期，请重新发起 ids_login。" }], isError: true };
        }
      }

      try {
        const outcome = await login({ username, password, captcha, service, jar, lang });

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
            structuredContent: { status: "captcha_required", continuation: token },
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
          structuredContent: { status: "ok", userId: outcome.userId, session },
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
      outputSchema: z.object({
        userId: z.string(),
        expiresAt: z.string(),
        alive: z.boolean(),
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
      return structured(
        ticket
          ? `有效：${token.userId}，句柄 ${expires} 到期；已成功换取 service ticket。`
          : `已失效：${token.userId}，请重新 ids_login。`,
        { userId: token.userId, expiresAt: expires, alive: Boolean(ticket) },
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
      outputSchema: z.object({ name: z.string().nullable(), studentId: z.string().nullable() }),
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
        return structured(`EAMS 会话可用：${profile.name ?? "姓名未知"}（学号 ${profile.studentId ?? "未知"}）`, {
          name: profile.name,
          studentId: profile.studentId,
        });
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
      outputSchema: z.object({
        defaultSemester: z.string().nullable(),
        semesters: z.array(z.object({ id: z.string(), year: z.string(), name: z.string() })),
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
        return structured([`共 ${result.semesters.length} 个学期：`, ...lines].join("\n"), {
          defaultSemester: result.defaultSemester,
          semesters: result.semesters,
        });
      } catch (cause) {
        const message = cause instanceof CampusSessionExpired ? cause.message : (cause as Error).message;
        return { content: [{ type: "text" as const, text: `EAMS 查询失败：${message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "eams_exams",
    {
      title: "EAMS 考试安排（期中/期末）",
      description:
        "从教务系统（EAMS）读取考试批次与排考表：课程、考试类型（期中考试/期末考试）、日期、时间、地点、状态。semester_id 省略时用默认学期；批次省略时用页面默认选中的批次。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        semester_id: z.string().optional().describe("学期 id（eams_semesters 返回）；省略用默认学期"),
        batch_id: z.string().optional().describe("考试批次 id；省略用默认批次（通常即“期末考试”）"),
      }),
      outputSchema: z.object({
        semesterId: z.string(),
        batch: z.object({ id: z.string(), name: z.string() }),
        count: z.number(),
        exams: z.array(
          z.object({
            courseCode: z.string(),
            courseName: z.string(),
            examType: z.string(),
            examDate: z.string(),
            examTimeRange: z.string(),
            examPlace: z.string(),
            examStatus: z.string(),
            remark: z.string(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, semester_id, batch_id }) => {
      try {
        const auth = await deriveEamsSession(unseal<IdsSessionToken>(session).cookies);
        const semesterId = semester_id ?? (await eamsSemesters(auth)).defaultSemester;
        if (!semesterId) return { content: [{ type: "text" as const, text: "EAMS 未返回默认学期，请显式传 semester_id。" }], isError: true };
        const { batch, exams } = await eamsExams(auth, semesterId, batch_id);
        if (exams.length === 0) return text(`${batch.name}：暂无排考记录。`);
        const lines = exams.map(
          (e) =>
            `${e.courseCode} ${e.courseName} | ${e.examType} | ${e.examDate} ${e.examTimeRange} | ${e.examPlace} | ${e.examStatus}${
              e.remark ? ` | ${e.remark}` : ""
            }`,
        );
        return structured([`学期 ${semesterId} · ${batch.name} · 共 ${exams.length} 场：`, ...lines].join("\n"), {
          semesterId,
          batch: { id: batch.id, name: batch.name },
          count: exams.length,
          exams: exams.map((e) => ({
            courseCode: e.courseCode,
            courseName: e.courseName,
            examType: e.examType,
            examDate: e.examDate,
            examTimeRange: e.examTimeRange,
            examPlace: e.examPlace,
            examStatus: e.examStatus,
            remark: e.remark,
          })),
        });
      } catch (cause) {
        return campusFailure("EAMS 考试查询失败", cause);
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
      outputSchema: z.object({ studentId: z.string().nullable() }),
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
        return structured(`eGate 会话可用：学号 ${student.studentId ?? "未知"}`, { studentId: student.studentId });
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
      outputSchema: z.object({
        userNo: z.string(),
        userName: z.string(),
        email: z.string().nullable(),
        userType: z.string().nullable(),
        violations: z.array(
          z.object({ type: z.string(), count: z.number().nullable(), blacklisted: z.boolean() }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session }) => {
      try {
        const profile = await libspaceMe(await platformAuth(session, libspaceSession));
        const violations = (profile.violationCountList ?? []).map((v) => ({
          type: typeof v.reservationType === "string" ? v.reservationType : "?",
          count: typeof v.violationCount === "number" ? v.violationCount : null,
          blacklisted: v.blacklisted === true,
        }));
        return structured(
          [
            `${profile.userName}（${profile.userNo}）${profile.userType ? ` · ${profile.userType}` : ""}`,
            profile.email ? `邮箱 ${profile.email}` : "",
            violations.length
              ? `记录：${violations
                  .map((v) => `${v.type}: 违约 ${v.count ?? "?"}${v.blacklisted ? "（黑名单）" : ""}`)
                  .join("；")}`
              : "无违约记录",
          ]
            .filter(Boolean)
            .join("\n"),
          {
            userNo: profile.userNo,
            userName: profile.userName,
            email: profile.email ?? null,
            userType: profile.userType ?? null,
            violations,
          },
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
      outputSchema: z.object({
        date: z.string(),
        type: z.string().nullable(),
        config: z
          .object({
            openStartTime: z.string(),
            openEndTime: z.string(),
            minDurationHours: z.number(),
            maxDurationHours: z.number(),
            cycleDays: z.number(),
          })
          .nullable(),
        roomCount: z.number(),
        rooms: z.array(
          z.object({
            id: z.number(),
            spaceName: z.string(),
            typeCode: z.string(),
            floorNo: z.number().nullable(),
            capacity: z.number().nullable(),
            freeSlots: z.number(),
            totalSlots: z.number(),
          }),
        ),
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

        const config = type ? await spaceConfig(auth, type).catch(() => null) : null;
        const header = config
          ? `${type} 开放 ${config.openStartTime}-${config.openEndTime}，单次 ${config.minDurationHours}-${config.maxDurationHours} 小时，可预约未来 ${config.cycleDays} 天`
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
        return structured(
          [header, `共 ${rooms.length} 间（显示 ${lines.length}）：`, ...lines].filter(Boolean).join("\n"),
          {
            date,
            type: type ?? null,
            config: config
              ? {
                  openStartTime: config.openStartTime,
                  openEndTime: config.openEndTime,
                  minDurationHours: config.minDurationHours,
                  maxDurationHours: config.maxDurationHours,
                  cycleDays: config.cycleDays,
                }
              : null,
            roomCount: rooms.length,
            rooms: rooms.slice(0, limit).map((room) => {
              const slots = room.slots ?? [];
              return {
                id: room.id,
                spaceName: room.spaceName,
                typeCode: room.typeCode,
                floorNo: room.floorNo ?? null,
                capacity: room.capacity ?? null,
                freeSlots: slots.filter((s) => s.statusCode === "AVAILABLE").length,
                totalSlots: slots.length,
              };
            }),
          },
        );
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
      outputSchema: z.object({
        spaceId: z.number(),
        date: z.string(),
        slots: z.array(z.object({ time: z.string(), statusCode: z.string() })),
        segments: z.array(z.object({ start: z.string(), end: z.string(), statusCode: z.string() })),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, space_id, date }) => {
      try {
        const detail = await libspaceSchedule(await platformAuth(session, libspaceSession), space_id, date);
        const segments = mergeSegments(detail.slots);
        return structured(`${detail.date} 空间 #${detail.spaceId}：\n${formatSegments(segments)}`, {
          spaceId: detail.spaceId,
          date: detail.date,
          slots: detail.slots.map((s) => ({ time: s.time, statusCode: s.statusCode })),
          segments,
        });
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
      outputSchema: z.object({
        mode: z.enum(["list", "detail"]),
        total: z.number().optional(),
        items: z
          .array(
            z.object({
              reservationId: z.number(),
              spaceName: z.string(),
              reserveDate: z.string(),
              startTime: z.string(),
              endTime: z.string(),
              status: z.string(),
              statusText: z.string(),
              canExtend: z.boolean(),
              signInWindow: z.boolean(),
            }),
          )
          .optional(),
        reservation: z
          .object({
            reservationId: z.number(),
            spaceName: z.string(),
            reserveDate: z.string(),
            startTime: z.string(),
            endTime: z.string(),
            status: z.string(),
            statusText: z.string(),
            canExtend: z.boolean(),
            signInWindow: z.boolean(),
            topic: z.string().nullable(),
            participants: z.string().nullable(),
          })
          .optional(),
        extendOptions: z
          .object({ allow: z.boolean(), maxExtendTimes: z.number().nullable(), options: z.array(z.unknown()) })
          .optional(),
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
          return structured(lines.filter(Boolean).join("\n"), {
            mode: "detail",
            reservation: {
              reservationId: detail.reservationId,
              spaceName: detail.spaceName,
              reserveDate: detail.reserveDate,
              startTime: detail.startTime,
              endTime: detail.endTime,
              status: detail.reservationStatus,
              statusText: detail.reservationStatusStr ?? detail.reservationStatus,
              canExtend: detail.canExtend ?? false,
              signInWindow: detail.signInWindow ?? false,
              topic: detail.meetingTopic ?? null,
              participants: detail.participantsName ?? null,
            },
            extendOptions: options
              ? {
                  allow: options.allow ?? false,
                  maxExtendTimes: options.maxExtendTimes ?? null,
                  options: options.options ?? [],
                }
              : undefined,
          });
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
        return structured([`共 ${page.total ?? lines.length} 条（显示 ${lines.length}）：`, ...lines].join("\n"), {
          mode: "list",
          total: page.total ?? page.list.length,
          items: page.list.map((r) => ({
            reservationId: r.reservationId,
            spaceName: r.spaceName,
            reserveDate: r.reserveDate,
            startTime: r.startTime,
            endTime: r.endTime,
            status: r.reservationStatus,
            statusText: r.reservationStatusStr ?? r.reservationStatus,
            canExtend: r.canExtend ?? false,
            signInWindow: r.signInWindow ?? false,
          })),
        });
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

  // ---------------------------------------------------------------- ecourse

  server.registerTool(
    "ecourse_courses",
    {
      title: "eCourse 我的课程",
      description: "列出本学期的 eCourse（TronClass）课程：课程 id、名称、课程号、院系、教师、选课人数。后续作业/考试/课件工具都用课程 id。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
      }),
      outputSchema: z.object({
        count: z.number(),
        courses: z.array(
          z.object({
            id: z.number(),
            name: z.string(),
            code: z.string().nullable(),
            year: z.string().nullable(),
            department: z.string().nullable(),
            instructors: z.array(z.string()),
            studentCount: z.number().nullable(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session }) => {
      try {
        const courses = await listCourses(await ecourseAuth(session));
        const lines = courses.map(
          (c) =>
            `#${c.id} ${c.name}${c.course_code ? ` (${c.course_code})` : ""} | ${c.department?.name ?? "-"} | ${
              (c.instructors ?? []).map((i) => i.name).join("/") || "-"
            } | ${c.course_attributes?.student_count ?? "?"} 人`,
        );
        return structured([`共 ${courses.length} 门课程：`, ...lines].join("\n"), {
          count: courses.length,
          courses: courses.map((c) => ({
            id: c.id,
            name: c.name,
            code: c.course_code ?? null,
            year: c.academic_year?.name ?? null,
            department: c.department?.name ?? null,
            instructors: (c.instructors ?? []).map((i) => i.name),
            studentCount: c.course_attributes?.student_count ?? null,
          })),
        });
      } catch (cause) {
        return campusFailure("ecourse 课程查询失败", cause);
      }
    },
  );

  server.registerTool(
    "ecourse_assignments",
    {
      title: "eCourse 作业与截止时间",
      description:
        "汇总作业（homework）及其截止时间，按截止先后排序。省略 course_id 时遍历我的课程（可用 course_limit 限制）；include_closed=false 可只看未截止。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        course_id: z.number().int().positive().optional().describe("只看这门课（ecourse_courses 的 id）"),
        include_closed: z.boolean().default(true).describe("是否包含已截止/已关闭的作业"),
        course_limit: z.number().int().min(1).max(20).default(10).describe("未指定 course_id 时最多遍历多少门课"),
        limit: z.number().int().min(1).max(100).default(40).describe("最多返回条数"),
      }),
      outputSchema: z.object({
        count: z.number(),
        items: z.array(
          z.object({
            courseId: z.number(),
            courseName: z.string(),
            activityId: z.number(),
            title: z.string(),
            dueAt: z.string().nullable(),
            closed: z.boolean(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, course_id, include_closed, course_limit, limit }) => {
      try {
        const auth = await ecourseAuth(session);
        const courses = (await listCourses(auth))
          .filter((c) => course_id === undefined || c.id === course_id)
          .slice(0, course_limit);
        const perCourse = await Promise.all(
          courses.map(async (c) => ({ course: c, activities: await listActivities(auth, c.id) })),
        );
        const items = perCourse
          .flatMap(({ course, activities }) =>
            activities
              .filter((a) => a.type === "homework")
              .map((a) => ({
                courseId: course.id,
                courseName: course.name,
                activityId: a.id,
                title: a.title,
                dueAt: a.end_time ?? null,
                closed: a.is_closed === true || (a.end_time ? Date.parse(a.end_time) < Date.now() : false),
              })),
          )
          .filter((a) => include_closed || !a.closed)
          .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"))
          .slice(0, limit);

        if (items.length === 0) return text(include_closed ? "没有作业。" : "没有未截止的作业。");
        const lines = items.map(
          (a) => `[${a.courseName}] ${a.title} | 截止 ${formatDeadline(a.dueAt)}${a.closed ? " (已关闭)" : ""} | #${a.activityId}`,
        );
        return structured([`共 ${items.length} 条作业：`, ...lines].join("\n"), { count: items.length, items });
      } catch (cause) {
        return campusFailure("ecourse 作业查询失败", cause);
      }
    },
  );

  server.registerTool(
    "ecourse_quizzes",
    {
      title: "eCourse 在线测验",
      description:
        "列出 eCourse（TronClass）里以“考试/测验”形式发布的在线测验及其开放时间。注意：这是课程内的线上测验，不是教务排考；期中/期末考试请用 eams_exams。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        course_id: z.number().int().positive().optional().describe("只看这门课"),
        course_limit: z.number().int().min(1).max(20).default(10).describe("未指定 course_id 时最多遍历多少门课"),
        limit: z.number().int().min(1).max(100).default(40).describe("最多返回条数"),
      }),
      outputSchema: z.object({
        count: z.number(),
        items: z.array(
          z.object({
            courseId: z.number(),
            courseName: z.string(),
            examId: z.number(),
            title: z.string(),
            startAt: z.string().nullable(),
            endAt: z.string().nullable(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, course_id, course_limit, limit }) => {
      try {
        const auth = await ecourseAuth(session);
        const courses = (await listCourses(auth))
          .filter((c) => course_id === undefined || c.id === course_id)
          .slice(0, course_limit);
        const perCourse = await Promise.all(courses.map(async (c) => ({ course: c, exams: await listExams(auth, c.id) })));
        const items = perCourse
          .flatMap(({ course, exams }) =>
            exams.map((e) => ({
              courseId: course.id,
              courseName: course.name,
              examId: e.id,
              title: e.title,
              startAt: e.start_time ?? null,
              endAt: e.end_time ?? null,
            })),
          )
          .sort((a, b) => (a.startAt ?? "9999").localeCompare(b.startAt ?? "9999"))
          .slice(0, limit);

        if (items.length === 0) return text("没有在线测验。");
        return structured(
          [
            `共 ${items.length} 个在线测验：`,
            ...items.map(
              (e) => `[${e.courseName}] ${e.title} | ${formatDeadline(e.startAt)} → ${formatDeadline(e.endAt)} | #${e.examId}`,
            ),
          ].join("\n"),
          { count: items.length, items },
        );
      } catch (cause) {
        return campusFailure("ecourse 考试查询失败", cause);
      }
    },
  );

  server.registerTool(
    "ecourse_classmates",
    {
      title: "eCourse 同班同学",
      description: "列出某门课的学生名单（学号、姓名、邮箱；平台会对邮箱打码）。教师/助教不在此列。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        course_id: z.number().int().positive().describe("课程 id"),
        limit: z.number().int().min(1).max(200).default(100).describe("最多返回人数"),
      }),
      outputSchema: z.object({
        count: z.number(),
        students: z.array(
          z.object({ name: z.string().nullable(), userNo: z.string().nullable(), email: z.string().nullable() }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, course_id, limit }) => {
      try {
        const enrollments = await listEnrollments(await ecourseAuth(session), course_id);
        const students = enrollments
          .filter((e) => e.roles.includes("student"))
          .map((e) => ({
            name: e.user?.name ?? null,
            userNo: e.user?.user_no ?? null,
            email: e.user?.email ?? null,
          }))
          .slice(0, limit);
        if (students.length === 0) return text("该课程没有可列出的学生（可能无权限或名单为空）。");
        return structured(
          [
            `共 ${students.length} 名学生：`,
            ...students.map((s) => `${s.userNo ?? "?"} ${s.name ?? "?"}${s.email ? ` ${s.email}` : ""}`),
          ].join("\n"),
          { count: students.length, students },
        );
      } catch (cause) {
        return campusFailure("ecourse 同学名单查询失败", cause);
      }
    },
  );

  server.registerTool(
    "ecourse_materials",
    {
      title: "eCourse 课件列表",
      description: "列出某门课的课件（material 活动）及其附件：upload id、文件名、大小。用 ecourse_material_download 取下载链接。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        course_id: z.number().int().positive().describe("课程 id"),
        limit: z.number().int().min(1).max(200).default(50).describe("最多返回课件数"),
      }),
      outputSchema: z.object({
        count: z.number(),
        items: z.array(
          z.object({
            activityId: z.number(),
            title: z.string(),
            published: z.boolean(),
            uploads: z.array(z.object({ id: z.number(), name: z.string(), size: z.number().nullable() })),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, course_id, limit }) => {
      try {
        const activities = await listActivities(await ecourseAuth(session), course_id);
        const items = activities
          .filter((a) => a.type === "material")
          .map((a) => ({
            activityId: a.id,
            title: a.title,
            published: a.published !== false,
            uploads: (a.uploads ?? []).map((u) => ({ id: u.id, name: u.name, size: u.size ?? null })),
          }))
          .slice(0, limit);
        if (items.length === 0) return text("该课程暂无课件。");
        const lines = items.flatMap((it) => [
          `${it.title}${it.published ? "" : "（未发布）"}`,
          ...it.uploads.map((u) => `  - ${u.name} [upload #${u.id}]${u.size ? ` ${(u.size / 1024).toFixed(0)}KB` : ""}`),
        ]);
        return structured([`共 ${items.length} 个课件：`, ...lines].join("\n"), { count: items.length, items });
      } catch (cause) {
        return campusFailure("ecourse 课件查询失败", cause);
      }
    },
  );

  server.registerTool(
    "ecourse_material_download",
    {
      title: "eCourse 课件下载",
      description:
        "为某个课件附件生成短时有效的签名下载链接（可直接 curl / 浏览器打开，支持 Range）。链接带 token 与到期时间，不要长期缓存或转发。",
      inputSchema: z.object({
        session: z.string().min(1).describe("ids_login 返回的 session 句柄"),
        upload_id: z.number().int().positive().describe("ecourse_materials 返回的 upload id"),
      }),
      outputSchema: z.object({
        uploadId: z.number(),
        name: z.string(),
        size: z.number().nullable(),
        downloadable: z.boolean(),
        url: z.string(),
        expiresAt: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session, upload_id }) => {
      try {
        const auth = await ecourseAuth(session);
        const [info, signed] = await Promise.all([uploadInfo(auth, upload_id), uploadUrl(auth, upload_id)]);
        const expires = signed.expiresAt ? new Date(signed.expiresAt).toISOString() : null;
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${info.name}${info.size ? ` (${(info.size / 1024).toFixed(0)}KB)` : ""}`,
                info.allow_download === false ? "平台标记为不允许下载" : "下载链接（短时有效）：",
                signed.url,
                expires ? `到期：${expires}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
            {
              type: "resource_link" as const,
              uri: signed.url,
              name: info.name,
              mimeType: info.type ?? "application/octet-stream",
            },
          ],
          structuredContent: {
            uploadId: upload_id,
            name: info.name,
            size: info.size ?? null,
            downloadable: info.allow_download !== false,
            url: signed.url,
            expiresAt: expires,
          },
        };
      } catch (cause) {
        return campusFailure("ecourse 课件下载失败", cause);
      }
    },
  );
}
