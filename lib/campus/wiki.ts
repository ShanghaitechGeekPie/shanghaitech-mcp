import { z } from "zod";

/**
 * WikiTech (wiki.geekpie.club) — Wiki.js 2.x.
 *
 * GraphQL at `${WIKI_BASE_URL}/graphql`.
 *   - `pages.list` / `pages.search` are readable anonymously (verified).
 *   - `pages.singleByPath(path, locale)` returns PageViewForbidden unless the
 *     request carries an API key: create one in Wiki.js admin → API Access and
 *     set `WIKI_API_TOKEN` (header `Authorization: Bearer <key>`).
 *
 * Locale is mandatory for singleByPath; the site's default content is `zh`.
 */

export const WIKI_BASE = (process.env.WIKI_BASE_URL ?? "https://wiki.geekpie.club").replace(/\/+$/, "");
const TOKEN = process.env.WIKI_API_TOKEN?.trim();

export class WikiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WikiError";
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

  const res = await fetch(`${WIKI_BASE}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    const message = body.errors[0]?.message ?? "unknown error";
    if (/not authorized|forbidden/i.test(message)) {
      throw new WikiError(
        TOKEN
          ? `Wiki 拒绝访问（${message}）：API key 可能缺少 pages:read 权限`
          : "Wiki 页面内容需要 API key：在 Wiki.js 管理后台 → API Access 创建 key，设置 WIKI_API_TOKEN",
        "forbidden",
      );
    }
    throw new WikiError(`Wiki GraphQL 错误：${message}`, "graphql_error");
  }
  if (!body.data) throw new WikiError("Wiki GraphQL 返回为空", "bad_payload");
  return body.data;
}

const SearchResult = z.object({
  pages: z.object({
    search: z.object({
      totalHits: z.number(),
      suggestions: z.array(z.string()).nullable().optional(),
      results: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          path: z.string(),
          description: z.string().nullable().optional(),
          locale: z.string().nullable().optional(),
        }),
      ),
    }),
  }),
});

export interface WikiHit {
  id: string;
  title: string;
  path: string;
  description: string | null;
  locale: string | null;
}

export async function wikiSearch(query: string): Promise<{ totalHits: number; suggestions: string[]; results: WikiHit[] }> {
  const data = await gql<unknown>(
    `query($q: String!) { pages { search(query: $q) { totalHits suggestions results { id title path description locale } } } }`,
    { q: query },
  );
  const parsed = SearchResult.safeParse(data);
  if (!parsed.success) throw new WikiError(`Wiki 搜索结构异常：${parsed.error.message.slice(0, 120)}`, "parse_drift");
  return {
    totalHits: parsed.data.pages.search.totalHits,
    suggestions: parsed.data.pages.search.suggestions ?? [],
    results: parsed.data.pages.search.results.map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      description: r.description ?? null,
      locale: r.locale ?? null,
    })),
  };
}

const Page = z.object({
  pages: z.object({
    singleByPath: z
      .object({
        id: z.number(),
        title: z.string(),
        path: z.string(),
        description: z.string().nullable().optional(),
        content: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
      })
      .loose()
      .nullable(),
  }),
});

export interface WikiPage {
  id: number;
  title: string;
  path: string;
  description: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export async function wikiPage(path: string, locale = "zh"): Promise<WikiPage | null> {
  const data = await gql<unknown>(
    `query($path: String!, $locale: String!) { pages { singleByPath(path: $path, locale: $locale) { id title path description content createdAt updatedAt } } }`,
    { path, locale },
  );
  const parsed = Page.safeParse(data);
  if (!parsed.success) throw new WikiError(`Wiki 页面结构异常：${parsed.error.message.slice(0, 120)}`, "parse_drift");
  const page = parsed.data.pages.singleByPath;
  if (!page) return null;
  return {
    id: page.id,
    title: page.title,
    path: page.path,
    description: page.description ?? null,
    content: page.content,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}
