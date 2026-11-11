/**
 * Small HTML helpers shared by the scraping adapters (EAMS, Blackboard).
 * Regex-based on purpose: campus pages are hand-written server-rendered HTML,
 * no DOM library is worth the bundle weight, and every parser fails loudly on
 * structure drift instead of returning empty results.
 */

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  hellip: "…",
  ndash: "–",
  mdash: "—",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
      return ENTITIES[code.toLowerCase()] ?? whole;
    });
}

/** Plain text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Value of an attribute inside a single tag string (e.g. `href`). */
export function attrOf(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]!) : null;
}
