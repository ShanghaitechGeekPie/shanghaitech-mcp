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
        return text(`eGate 会话可用：${student.name ?? "姓名未知"}（学号 ${student.studentId ?? "未知"}）`);
      } catch (cause) {
        const message = cause instanceof CampusSessionExpired ? cause.message : (cause as Error).message;
        return { content: [{ type: "text" as const, text: `eGate 登录失败：${message}` }], isError: true };
      }
    },
  );
}
