/**
 * Campus capability catalog — "where do I go to do X on campus".
 *
 * Every entry is an **entry point**, not a wrapper: most campus features are
 * deliberately not MCP-wrapped, the assistant's job is to tell the student
 * which page to open. Entries carry keywords (zh/en), so one query can surface
 * several platforms at once (e.g. 课表 → EAMS 我的课表 + eCourse 课程).
 *
 * URLs verified against the live systems on 2026-11-11; EAMS entries were
 * scraped from the real menu (`home!childmenus.action?menu.id=165/176`), not
 * guessed.
 */

export interface CatalogEntry {
  id: string;
  platform: PlatformId;
  /** Menu title as the student sees it. */
  title: string;
  /** One line describing what it is for. */
  description: string;
  url: string;
  /** Search terms, Chinese and English. */
  keywords: string[];
  /** MCP tool that already wraps this feature (optional). */
  tool?: string;
  /** Needs IDS login (all campus pages except public data do). */
  requiresAuth?: boolean;
}

export type PlatformId = "eams" | "ecourse" | "elearning" | "elrc" | "libspace" | "coursebench" | "egate" | "campus";

export const PLATFORM_TITLES: Record<PlatformId, string> = {
  eams: "教务系统 EAMS",
  ecourse: "eCourse（TronClass）",
  libspace: "图书馆空间预约",
  elearning: "Blackboard（elearning）",
  elrc: "ELRC 在线课堂",
  coursebench: "CourseBench 课程评价",
  egate: "服务大厅 eGate",
  campus: "校园其他服务",
};

const EAMS = "https://eams.shanghaitech.edu.cn";

export const CATALOG: CatalogEntry[] = [
  // ---------------------------------------------------------------- EAMS
  {
    id: "eams.schedule",
    platform: "eams",
    title: "我的课表",
    description: "学生每学期的课表查询",
    url: `${EAMS}/eams/courseTableForStd.action`,
    keywords: ["课表", "课程表", "上课时间", "教室", "timetable", "schedule"],
    requiresAuth: true,
  },
  {
    id: "eams.exam",
    platform: "eams",
    title: "我的考试",
    description: "每学期的期中/期末考试安排（时间、地点）",
    url: `${EAMS}/eams/stdExamTable.action`,
    keywords: ["考试", "期中", "期末", "排考", "考场", "exam"],
    tool: "eams_exams",
    requiresAuth: true,
  },
  {
    id: "eams.grade",
    platform: "eams",
    title: "我的成绩",
    description: "每学期成绩查询",
    url: `${EAMS}/eams/teach/grade/course/person.action`,
    keywords: ["成绩", "分数", "绩点", "gpa", "grade", "score"],
    requiresAuth: true,
  },
  {
    id: "eams.rank",
    platform: "eams",
    title: "成绩排名获取",
    description: "GPA / 专业排名证明申请",
    url: `${EAMS}/eams/teach/grade/stat/studentGpaApply.action`,
    keywords: ["排名", "名次", "rank", "ranking", "gpa", "证明"],
    requiresAuth: true,
  },
  {
    id: "eams.transcript",
    platform: "eams",
    title: "电子成绩单获取",
    description: "中英文电子成绩单下载/申请",
    url: `${EAMS}/eams/teach/grade/transcript/stdPrinterApply.action`,
    keywords: ["成绩单", "transcript", "证明", "出国"],
    requiresAuth: true,
  },
  {
    id: "eams.average",
    platform: "eams",
    title: "电子均分证明获取",
    description: "均分证明申请",
    url: `${EAMS}/eams/stdAverageApply.action`,
    keywords: ["均分", "平均分", "证明", "average"],
    requiresAuth: true,
  },
  {
    id: "eams.plan",
    platform: "eams",
    title: "培养方案",
    description: "所属年级/专业的培养方案查看",
    url: `${EAMS}/eams/myPlan.action`,
    keywords: ["培养方案", "培养计划", "curriculum", "plan", "学分要求"],
    requiresAuth: true,
  },
  {
    id: "eams.planProgress",
    platform: "eams",
    title: "计划完成情况",
    description: "培养方案要求的课程与学分已修读情况",
    url: `${EAMS}/eams/myPlanCompl.action`,
    keywords: ["完成情况", "学分", "毕业审核", "培养方案", "progress"],
    requiresAuth: true,
  },
  {
    id: "eams.profile",
    platform: "eams",
    title: "学籍信息",
    description: "个人学籍信息（院系、专业、年级、学号）",
    url: `${EAMS}/eams/stdDetail.action`,
    keywords: ["学籍", "学号", "专业", "院系", "profile"],
    tool: "eams_profile",
    requiresAuth: true,
  },
  {
    id: "eams.elect",
    platform: "eams",
    title: "选课",
    description: "学生选课（正选/退改选）",
    url: `${EAMS}/eams/stdElectCourse.action`,
    keywords: ["选课", "退课", "抢课", "elect", "course selection"],
    requiresAuth: true,
  },
  {
    id: "eams.courseSearch",
    platform: "eams",
    title: "本科课程信息查询",
    description: "全校开设课程信息与课程大纲",
    url: `${EAMS}/eams/courseSearchOther.action`,
    keywords: ["课程信息", "课程大纲", "开课", "syllabus", "course"],
    requiresAuth: true,
  },
  {
    id: "eams.alert",
    platform: "eams",
    title: "我的预警",
    description: "学业预警查询",
    url: `${EAMS}/eams/alertInfoForStd.action`,
    keywords: ["预警", "学业预警", "warning"],
    requiresAuth: true,
  },
  {
    id: "eams.tutor",
    platform: "eams",
    title: "书院导师 / 学业导师",
    description: "导师名单与联系方式",
    url: `${EAMS}/eams/departStudentTutor.action`,
    keywords: ["导师", "书院导师", "学业导师", "tutor"],
    requiresAuth: true,
  },
  {
    id: "eams.textbook",
    platform: "eams",
    title: "教材订购",
    description: "教材订购与查询",
    url: `${EAMS}/eams/stdTextbookOrderLine.action`,
    keywords: ["教材", "订书", "textbook", "book"],
    requiresAuth: true,
  },
  {
    id: "eams.pnp",
    platform: "eams",
    title: "P/NP 申请",
    description: "课程 P/NP 计分方式申请",
    url: `${EAMS}/eams/pnp/std-pnp-apply.action`,
    keywords: ["pnp", "p/np", "通过不通过", "计分"],
    requiresAuth: true,
  },
  {
    id: "eams.classroom",
    platform: "eams",
    title: "教室预览 / 借用",
    description: "查看教室占用、申请借用教室",
    url: `${EAMS}/eams/stdClassroomPreview.action`,
    keywords: ["教室", "借用", "空闲教室", "classroom"],
    requiresAuth: true,
  },
  {
    id: "eams.english",
    platform: "eams",
    title: "校级英语成绩",
    description: "校级英语测试成绩查询",
    url: `${EAMS}/eams/myOtherEngGrade.action`,
    keywords: ["英语", "英语成绩", "english"],
    requiresAuth: true,
  },
  {
    id: "eams.thesis",
    platform: "eams",
    title: "我的毕业论文",
    description: "毕业论文流程与材料",
    url: `${EAMS}/eams/home!childmenus.action?menu.id=902`,
    keywords: ["毕业论文", "毕设", "thesis"],
    requiresAuth: true,
  },
  {
    id: "eams.minor",
    platform: "eams",
    title: "我的辅修",
    description: "辅修专业信息",
    url: `${EAMS}/eams/home!childmenus.action?menu.id=1045`,
    keywords: ["辅修", "minor"],
    requiresAuth: true,
  },
  {
    id: "eams.external",
    platform: "eams",
    title: "校外课程",
    description: "校外课程认定/学分转换",
    url: `${EAMS}/eams/home!childmenus.action?menu.id=803`,
    keywords: ["校外课程", "学分认定", "exchange"],
    requiresAuth: true,
  },
  {
    id: "eams.manual",
    platform: "eams",
    title: "教务系统操作手册",
    description: "学生端操作手册（Word）",
    url: `${EAMS}/eams/documentDownload!download.action?document.id=41&curProfileId=1`,
    keywords: ["手册", "帮助", "manual", "guide"],
    requiresAuth: true,
  },

  // ---------------------------------------------------------------- eCourse
  {
    id: "ecourse.courses",
    platform: "ecourse",
    title: "我的课程",
    description: "TronClass 课程列表与课程主页",
    url: "https://ecourse.shanghaitech.edu.cn/",
    keywords: ["课程", "ecourse", "tronclass", "course"],
    tool: "ecourse_courses",
    requiresAuth: true,
  },
  {
    id: "ecourse.assignments",
    platform: "ecourse",
    title: "作业与截止时间",
    description: "各课程的作业（homework）与 DDL",
    url: "https://ecourse.shanghaitech.edu.cn/",
    keywords: ["作业", "ddl", "deadline", "homework", "截止"],
    tool: "ecourse_assignments",
    requiresAuth: true,
  },
  {
    id: "ecourse.quizzes",
    platform: "ecourse",
    title: "在线测验",
    description: "课程内线上测验（不是教务排考）",
    url: "https://ecourse.shanghaitech.edu.cn/",
    keywords: ["测验", "quiz", "在线考试", "考试", "test"],
    tool: "ecourse_quizzes",
    requiresAuth: true,
  },
  {
    id: "ecourse.classmates",
    platform: "ecourse",
    title: "同班同学",
    description: "课程学生名单",
    url: "https://ecourse.shanghaitech.edu.cn/",
    keywords: ["同学", "名单", "classmates", "roster"],
    tool: "ecourse_classmates",
    requiresAuth: true,
  },
  {
    id: "ecourse.materials",
    platform: "ecourse",
    title: "课件与资料下载",
    description: "课程 PPT/讲义，可下载",
    url: "https://ecourse.shanghaitech.edu.cn/",
    keywords: ["课件", "ppt", "讲义", "资料", "下载", "material", "slides"],
    tool: "ecourse_materials",
    requiresAuth: true,
  },

  // ---------------------------------------------------------------- elearning
  {
    id: "elearning.announcements",
    platform: "elearning",
    title: "通知公告",
    description: "课程通知与机构公告（Blackboard）",
    url: "https://elearning.shanghaitech.edu.cn:8443/",
    keywords: ["通知", "公告", "announcement", "notice", "消息"],
    tool: "elearning_announcements",
    requiresAuth: true,
  },
  {
    id: "elearning.assignments",
    platform: "elearning",
    title: "作业与截止日期",
    description: "Blackboard 课程作业及 DDL、提交入口",
    url: "https://elearning.shanghaitech.edu.cn:8443/",
    keywords: ["作业", "ddl", "deadline", "assignment", "提交", "截止"],
    tool: "elearning_assignments",
    requiresAuth: true,
  },
  {
    id: "elearning.files",
    platform: "elearning",
    title: "课件与资料",
    description: "课程内容目录、课件下载",
    url: "https://elearning.shanghaitech.edu.cn:8443/",
    keywords: ["课件", "资料", "下载", "ppt", "pdf", "courseware", "file"],
    tool: "elearning_contents",
    requiresAuth: true,
  },
  {
    id: "elearning.courses",
    platform: "elearning",
    title: "我的 Blackboard 课程",
    description: "已注册课程列表与课程 id",
    url: "https://elearning.shanghaitech.edu.cn:8443/",
    keywords: ["blackboard", "课程", "course", "elearning"],
    tool: "elearning_courses",
    requiresAuth: true,
  },

  // ---------------------------------------------------------------- elrc
  {
    id: "elrc.recordings",
    platform: "elrc",
    title: "我的课程与录播",
    description: "当前学期课程列表（含是否有录播）",
    url: "https://elrc.shanghaitech.edu.cn/unifiedplatform/#/learn/mycourse",
    keywords: ["录播", "回放", "在线课堂", "视频", "讲课", "我的课程", "recording", "video", "elrc"],
    tool: "elrc_courses",
    requiresAuth: true,
  },
  {
    id: "elrc.course",
    platform: "elrc",
    title: "课程详情（大纲/安排/关联平台）",
    description: "教学大纲、上课安排、章节、Blackboard 与 eCourse 链接",
    url: "https://elrc.shanghaitech.edu.cn/unifiedplatform/#/learn/mycourse",
    keywords: ["大纲", "教学大纲", "上课安排", "课程安排", "学分", "课程简介", "syllabus", "schedule"],
    tool: "elrc_course",
    requiresAuth: true,
  },
  {
    id: "elrc.transcript",
    platform: "elrc",
    title: "回放语音转写与知识点定位",
    description: "带时间戳的转写，可按时段/关键词定位讲了什么",
    url: "https://elrc.shanghaitech.edu.cn/learn/videoreview",
    keywords: ["转写", "字幕", "语音", "时间戳", "知识点", "复习", "transcript", "subtitle"],
    tool: "elrc_transcript",
    requiresAuth: true,
  },
  {
    id: "elrc.summary",
    platform: "elrc",
    title: "回放 AI 摘要与分节",
    description: "AI 摘要、关键词、知识点分节（起止时间）",
    url: "https://elrc.shanghaitech.edu.cn/learn/videoreview",
    keywords: ["ai 总结", "摘要", "分节", "知识点", "summary", "chapter"],
    tool: "elrc_recording",
    requiresAuth: true,
  },
  {
    id: "elrc.slides",
    platform: "elrc",
    title: "课件截图（slides）",
    description: "按时间点对应的课件截图与 OCR 文本",
    url: "https://elrc.shanghaitech.edu.cn/learn/videoreview",
    keywords: ["课件", "ppt", "slides", "截图", "板书"],
    tool: "elrc_slides",
    requiresAuth: true,
  },

  // ---------------------------------------------------------------- libspace
  {
    id: "libspace.rooms",
    platform: "libspace",
    title: "空间预约（讨论室/研习室/静音舱）",
    description: "图书馆空间查询与预约",
    url: "https://libspace.shanghaitech.edu.cn/",
    keywords: ["座位", "自习", "讨论室", "研习室", "静音舱", "预约", "room", "seat"],
    tool: "libspace_spaces",
    requiresAuth: true,
  },
  {
    id: "libspace.my",
    platform: "libspace",
    title: "我的预约",
    description: "查看/取消/签到/延长已预约空间",
    url: "https://libspace.shanghaitech.edu.cn/",
    keywords: ["我的预约", "签到", "取消预约", "reservation"],
    tool: "libspace_reservations",
    requiresAuth: true,
  },

  // ---------------------------------------------------------------- egate
  {
    id: "egate.hall",
    platform: "egate",
    title: "服务大厅 eGate",
    description: "各类线上办事（证明、申请、活动签到）",
    url: "https://egate.shanghaitech.edu.cn/",
    keywords: ["服务大厅", "办事", "申请", "证明", "egate", "签到"],
    requiresAuth: true,
  },
  {
    id: "egate.gym",
    platform: "egate",
    title: "体育馆场地预约",
    description: "羽毛球/乒乓/网球/匹克球场地预约（OA 流程）",
    url: "https://oa.shanghaitech.edu.cn/workflow/request/AddRequest.jsp?workflowid=14862",
    keywords: ["体育馆", "场地", "羽毛球", "乒乓", "网球", "匹克球", "gym", "booking"],
    requiresAuth: true,
  },

  // ---------------------------------------------------------------- coursebench
  {
    id: "coursebench.search",
    platform: "coursebench",
    title: "课程评价搜索",
    description: "学长学姐的课程评分与点评（公开数据）",
    url: "https://coursebench.zambar.dev/",
    keywords: ["课程评价", "点评", "打分", "选课参考", "coursebench", "review"],
    tool: "coursebench_search_courses",
  },

  // ---------------------------------------------------------------- campus
  {
    id: "campus.library",
    platform: "campus",
    title: "图书馆（借阅/数据库/研讨间）",
    description: "馆藏检索、数据库、借阅记录",
    url: "https://library.shanghaitech.edu.cn/",
    keywords: ["图书馆", "借书", "数据库", "论文", "library", "paper"],
    requiresAuth: true,
  },
  {
    id: "campus.mail",
    platform: "campus",
    title: "校园邮箱",
    description: "Coremail 邮箱（登录需二次验证）",
    url: "https://mail.shanghaitech.edu.cn/",
    keywords: ["邮箱", "邮件", "mail", "email"],
    requiresAuth: true,
  },
  {
    id: "campus.oj",
    platform: "campus",
    title: "OJ 在线评测",
    description: "ShanghaiTech ACM / Hydro 判题系统",
    url: "https://acm.shanghaitech.edu.cn/",
    keywords: ["oj", "刷题", "算法", "acm", "judge"],
  },
  {
    id: "campus.vpn",
    platform: "campus",
    title: "校园 VPN",
    description: "校外访问校内资源（aTrust）",
    url: "https://vpn.shanghaitech.edu.cn/portal/",
    keywords: ["vpn", "校外访问", "内网", "atrust"],
  },
  {
    id: "campus.it",
    platform: "campus",
    title: "信息化服务 / IT 帮助",
    description: "网络、账号、软件正版化等 IT 服务",
    url: "https://it.shanghaitech.edu.cn/",
    keywords: ["it", "网络", "账号", "软件", "帮助", "helpdesk"],
  },
];

/** Query-side synonyms, applied in addition to the literal query. */
const SYNONYMS: Record<string, string[]> = {
  课表: ["课程表", "上课", "时间表", "schedule", "timetable"],
  成绩: ["分数", "绩点", "gpa", "grade"],
  排名: ["名次", "rank", "ranking"],
  考试: ["期中", "期末", "排考", "exam"],
  作业: ["ddl", "deadline", "homework"],
  课件: ["ppt", "讲义", "资料", "slides"],
  座位: ["自习", "研讨室", "研习室", "静音舱", "预约", "seat"],
  图书馆: ["借书", "数据库", "论文", "library"],
  体育: ["体育馆", "场地", "羽毛球", "gym"],
  毕业: ["毕业论文", "毕设", "学分", "thesis"],
  选课: ["退课", "抢课", "elect"],
};

function bigrams(text: string): string[] {
  const s = text.replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function scoreEntry(entry: CatalogEntry, terms: Array<{ term: string; weight: number }>, raw: string): number {
  const title = entry.title.toLowerCase();
  const haystack = `${entry.title} ${entry.description} ${entry.keywords.join(" ")}`.toLowerCase();
  let score = 0;

  // Bigram overlap alone must not qualify an entry (「图书馆」×「毕业论文」noise);
  // it only ranks entries that already matched a term.
  let termHits = 0;
  for (const { term, weight } of terms) {
    if (title === term) score += 100 * weight;
    else if (title.includes(term)) score += 60 * weight;
    if (entry.keywords.some((k) => k.toLowerCase() === term)) score += 50 * weight;
    else if (entry.keywords.some((k) => k.toLowerCase().includes(term) || term.includes(k.toLowerCase()))) score += 25 * weight;
    if (entry.description.toLowerCase().includes(term)) score += 15 * weight;
    if (title.includes(term) || entry.keywords.some((k) => k.toLowerCase().includes(term))) termHits++;
  }
  if (termHits === 0) return 0;

  // Chinese has no word boundaries: add character-bigram overlap for fuzzy asks
  // like 「我想看下学期课表」.
  const hay = bigrams(haystack);
  const q = bigrams(raw);
  if (q.length > 0) {
    const hits = q.filter((g) => hay.includes(g)).length;
    score += Math.min(30, hits * 3);
  }
  return score;
}

export interface CatalogHit {
  entry: CatalogEntry;
  score: number;
}

export function searchCatalog(query: string, platform?: PlatformId, limit = 10): CatalogHit[] {
  const raw = query.trim().toLowerCase();
  const terms: Array<{ term: string; weight: number }> = [];
  const add = (term: string, weight: number) => {
    if (term && !terms.some((t) => t.term === term)) terms.push({ term, weight });
  };
  add(raw, 1);
  for (const v of SYNONYMS[raw] ?? []) add(v.toLowerCase(), 0.6);
  for (const [key, values] of Object.entries(SYNONYMS)) {
    if (raw.includes(key)) for (const v of values) add(v.toLowerCase(), 0.6);
  }

  const pool = platform ? CATALOG.filter((e) => e.platform === platform) : CATALOG;
  if (terms.length === 0) {
    return pool.slice(0, limit).map((entry) => ({ entry, score: 0 }));
  }

  const hits = pool
    .map((entry) => ({ entry, score: scoreEntry(entry, terms, raw) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
  const top = hits[0]?.score ?? 0;
  const kept = hits.filter((hit) => hit.score >= top * 0.15);

  // Cross-platform coverage: the whole point of this tool is that one ask can
  // hit several platforms (考试 → 教务排考 + 在线测验). Always keep each
  // platform's best entry when it matched at all.
  const seen = new Set(kept.map((h) => h.entry.platform));
  for (const hit of hits) {
    if (seen.has(hit.entry.platform)) continue;
    seen.add(hit.entry.platform);
    kept.push(hit);
  }

  return kept.sort((a, b) => b.score - a.score).slice(0, limit);
}
