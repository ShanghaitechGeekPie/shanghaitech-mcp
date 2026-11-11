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
}
