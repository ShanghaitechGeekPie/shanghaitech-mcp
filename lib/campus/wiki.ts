import { readFileSync } from "node:fs";
import { decodeEntities } from "./html";
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

/**
 * API key lookup: env first, then a local file so the key never has to be
 * pasted into a chat or committed. Vercel uses the env var only.
 */
function readToken(): string | undefined {
  const fromEnv = process.env.WIKI_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = process.env.WIKI_TOKEN_FILE ?? `${process.env.HOME ?? ""}/.config/shanghaitech-mcp/wiki.token`;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

const TOKEN = readToken();

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

/**
 * Page content.
 *
 * GraphQL `singleByPath` is the clean path but is gated per-page (an API key
 * without page rights gets `PageViewForbidden`). The public site renders the
 * body server-side into `<template slot="contents">`, so we fall back to that:
 * no credentials needed for public pages.
 */
export async function wikiPage(path: string, locale = "zh"): Promise<WikiPage | null> {
  if (TOKEN) {
    try {
      const data = await gql<unknown>(
        `query($path: String!, $locale: String!) { pages { singleByPath(path: $path, locale: $locale) { id title path description content createdAt updatedAt } } }`,
        { path, locale },
      );
      const parsed = Page.safeParse(data);
      if (parsed.success && parsed.data.pages.singleByPath) {
        const page = parsed.data.pages.singleByPath;
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
    } catch (cause) {
      if (!(cause instanceof WikiError) || cause.code !== "forbidden") throw cause;
      // fall through to the rendered page
    }
  }
  return wikiPageFromHtml(path, locale);
}

function htmlToText(html: string): string {
  const s = html
    .replace(/<a[^>]*class="toc-anchor"[^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function wikiPageFromHtml(path: string, locale: string): Promise<WikiPage | null> {
  const url = `${WIKI_BASE}/${encodeURIComponent(locale)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new WikiError(`Wiki 页面返回 HTTP ${res.status}`, String(res.status));
  const html = await res.text();
  const body = html.match(/<template[^>]*slot="contents"[^>]*>([\s\S]*?)<\/template>/i)?.[1];
  if (!body) throw new WikiError(`Wiki 页面未包含渲染内容（${html.length} 字节）`, "parse_drift");
  const title = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return {
    id: 0,
    title: title ? decodeEntities(title.replace(/<[^>]+>/g, "")).replace(/¶/g, "").trim() : path,
    path,
    description: null,
    content: htmlToText(body),
    createdAt: "",
    updatedAt: "",
  };
}
