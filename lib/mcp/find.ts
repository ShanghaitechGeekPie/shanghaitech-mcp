import { CATALOG, type CatalogEntry, type PlatformId } from "@/lib/campus/catalog";
import { toolIndex } from "@/lib/mcp/registry";

/**
 * Unified campus find.
 *
 * One entry point for "where/how do I do X": ranks **executable tools** and
 * **web entry points** together. The LLM passes free text; we split it into
 * keywords (spaces / commas) and score title, keywords and description of both
 * kinds, with Chinese bigram overlap for long asks.
 */

export interface FindHit {
  kind: "tool" | "entry";
  score: number;
  /** Tool name for `kind: "tool"`. */
  name?: string;
  platform: string;
  title: string;
  description: string;
  /** For entries: the page to open. */
  url?: string;
  /** For entries: the tool that already wraps this feature. */
  tool?: string;
  requiresAuth?: boolean;
}

interface Doc {
  kind: "tool" | "entry";
  platform: string;
  title: string;
  description: string;
  keywords: string[];
  name?: string;
  entry?: CatalogEntry;
}

function bigrams(text: string): string[] {
  const s = text.replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function splitKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、;；|/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scoreDoc(doc: Doc, keywords: string[], raw: string): number {
  const title = doc.title.toLowerCase();
  const keywordsLower = doc.keywords.map((k) => k.toLowerCase());
  const desc = doc.description.toLowerCase();
  const haystack = `${title} ${keywordsLower.join(" ")} ${desc}`;

  let score = 0;
  let matched = 0;
  for (const kw of keywords) {
    let hit = 0;
    if (title === kw) hit += 60;
    else if (title.includes(kw)) hit += 40;
    if (keywordsLower.includes(kw)) hit += 50;
    else if (keywordsLower.some((k) => k.includes(kw) || kw.includes(k))) hit += 30;
    if (desc.includes(kw)) hit += 15;
    if (hit > 0) matched++;
    score += hit;
  }
  if (matched === 0) {
    // Chinese asked as a sentence ("我想看下学期的课表"): bigrams may still hit,
    // but only for docs already carrying a strong keyword surface.
    const q = bigrams(raw);
    const hay = bigrams(haystack);
    const overlap = q.filter((g) => hay.includes(g)).length;
    if (overlap < 2) return 0;
    score += Math.min(30, overlap * 4);
  } else {
    score += (matched / keywords.length) * 20;
  }
  // Tools are directly executable, so they win ties against plain links.
  if (doc.kind === "tool") score += 5;
  return score;
}

export interface FindOptions {
  query?: string;
  platform?: PlatformId;
  kind?: "tool" | "entry";
  limit?: number;
}

export function findCampus(opts: FindOptions = {}): FindHit[] {
  const limit = opts.limit ?? 10;
  const raw = (opts.query ?? "").trim().toLowerCase();
  const keywords = splitKeywords(raw);

  const docs: Doc[] = [
    ...toolIndex()
      .filter((t) => t.name !== "campus_find") // the finder must not match itself
      .map((t) => ({
        kind: "tool" as const,
        platform: t.platform,
        title: t.title,
        description: t.description,
        keywords: [] as string[],
        name: t.name,
      })),
    ...CATALOG.map((entry) => ({
      kind: "entry" as const,
      platform: entry.platform,
      title: entry.title,
      description: entry.description,
      keywords: entry.keywords,
      entry,
    })),
  ].filter((doc) => !opts.platform || doc.platform === opts.platform) as Doc[];

  const pool = opts.kind ? docs.filter((d) => d.kind === opts.kind) : docs;

  if (keywords.length === 0) {
    return pool.slice(0, limit).map(toHit(0));
  }

  const scored = pool
    .map((doc) => ({ doc, score: scoreDoc(doc, keywords, raw) }))
    .filter((x) => x.score > 0);

  // An entry that wraps a tool makes that tool relevant: 「座位」 matches the
  // entry's keywords, and the entry points at libspace_spaces.
  const wrapped: Record<string, number> = {};
  for (const { doc, score } of scored) {
    if (doc.kind === "entry" && doc.entry?.tool) {
      wrapped[doc.entry.tool] = Math.max(wrapped[doc.entry.tool] ?? 0, score);
    }
  }
  for (const hit of scored) {
    const boost = hit.doc.kind === "tool" && hit.doc.name ? wrapped[hit.doc.name] : undefined;
    if (boost) hit.score += boost * 0.6;
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0]?.score ?? 0;
  const kept = scored.filter((x) => x.score >= top * 0.25);

  // Per-platform cap (top 3 each) keeps one noisy platform from crowding out
  // the others without discarding its runners-up.
  const perPlatform = new Map<string, number>();
  const capped = kept.filter((hit) => {
    const used = perPlatform.get(hit.doc.platform) ?? 0;
    if (used >= 3) return false;
    perPlatform.set(hit.doc.platform, used + 1);
    return true;
  });

  // Both kinds matter: a query usually has an executable answer and a page to
  // fall back to. Keep each kind's best even if it fell under the cutoff.
  const hasKind = new Set(capped.map((x) => x.doc.kind));
  for (const kind of ["tool", "entry"] as const) {
    if (hasKind.has(kind)) continue;
    const best = scored.find((x) => x.doc.kind === kind);
    if (best) capped.push(best);
  }

  return capped
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => toHit(x.score)(x.doc));
}

function toHit(score: number) {
  return (doc: Doc): FindHit => ({
    kind: doc.kind,
    score,
    name: doc.name,
    platform: doc.platform,
    title: doc.title,
    description: doc.description,
    url: doc.entry?.url,
    tool: doc.entry?.tool,
    requiresAuth: doc.entry?.requiresAuth,
  });
}

