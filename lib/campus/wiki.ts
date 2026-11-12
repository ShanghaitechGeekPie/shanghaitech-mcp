import { decodeEntities } from "./html";
import { z } from "zod";

/**
 * WikiTech (wiki.geekpie.club) — Wiki.js 2.x.
 *
 * Search goes through GraphQL (`pages.search`, anonymous). Page content does
 * NOT: `pages.singleByPath` is gated server-side on this deployment — an
 * Administrator API key still gets `PageViewForbidden 6013` — so the body is
 * taken from the public rendered page (`<template slot="contents">`).
 *
 * No credentials are needed or accepted.
 */

export const WIKI_BASE = (process.env.WIKI_BASE_URL ?? "https://wiki.geekpie.club").replace(/\/+$/, "");

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
  const res = await fetch(`${WIKI_BASE}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    const message = body.errors[0]?.message ?? "unknown error";
    if (/not authorized|forbidden/i.test(message)) {
      throw new WikiError(`Wiki 拒绝访问（${message}）`, "forbidden");
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
 * GraphQL `singleByPath` is gated server-side on this deployment (even an
 * Administrator API key gets PageViewForbidden 6013), so content comes from the
 * public rendered page: the body lives in `<template slot="contents">`.
 */
export async function wikiPage(path: string, locale = "zh"): Promise<WikiPage | null> {
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
