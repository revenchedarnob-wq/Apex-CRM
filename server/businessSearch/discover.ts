import { canonicalFacebookPage, type FacebookPageRef } from "../../src/utils/leadDedupe.js";
import type { BusinessSearchSpec } from "./brief.js";

/** A search hit that points at a Facebook Page, with the snippet kept as fallback data. */
export type DiscoveredPage = FacebookPageRef & {
  title: string;
  snippet: string;
  query: string;
  provider: "tavily" | "brightdata";
};

export type SearchHit = { url: string; title?: string; content?: string };

export type DiscoverDeps = {
  tavilySearch?: (query: string, signal?: AbortSignal) => Promise<SearchHit[]>;
  brightDataSearch?: (query: string, signal?: AbortSignal) => Promise<SearchHit[]>;
};

/**
 * Builds 4 to 12 query variants. Every variant keeps the category and the place, so
 * no query drifts into another city or trade; variants differ in phrasing only.
 */
export function buildDiscoveryQueries(spec: BusinessSearchSpec, maxQueries = 8): string[] {
  const category = spec.categoryTerms.join(" ").trim();
  if (!category) return [];
  const place = spec.place.trim();
  const inPlace = place ? ` ${place}` : "";
  const quotedPlace = place ? ` "${place}"` : "";
  const extras = spec.extras.slice(0, 2);

  const queries = [
    `site:facebook.com ${category}${inPlace}`,
    `site:facebook.com "${category}"${quotedPlace}`,
    `${category}${inPlace} facebook page`,
    // Other names for the trade, from the AI, find Pages that describe themselves differently.
    ...(spec.synonyms || [])
      .filter((synonym) => synonym.toLowerCase() !== category.toLowerCase())
      .slice(0, 2)
      .map((synonym) => `site:facebook.com ${synonym}${inPlace}`),
    `site:facebook.com ${category}${inPlace} contact`,
    `site:facebook.com ${category}${inPlace} "local business"`,
    `site:facebook.com ${category}${inPlace} phone email`,
    ...extras.map((extra) => `site:facebook.com ${category} ${extra}${inPlace}`),
  ];
  return Array.from(new Set(queries)).slice(0, Math.max(1, Math.min(maxQueries, 12)));
}

/**
 * Keeps only hits that are Facebook Pages, canonicalizes them, drops duplicates and
 * drops Pages whose identity is already in the CRM. No network, no LLM.
 */
export function filterPageHits(
  hits: Array<SearchHit & { query: string; provider: DiscoveredPage["provider"] }>,
  existingKeys: Set<string> = new Set(),
): { pages: DiscoveredPage[]; skippedNotPage: number; skippedDuplicate: number; skippedKnown: number } {
  const pages: DiscoveredPage[] = [];
  const seen = new Set<string>();
  let skippedNotPage = 0;
  let skippedDuplicate = 0;
  let skippedKnown = 0;
  for (const hit of hits) {
    const page = canonicalFacebookPage(hit.url);
    if (!page) {
      skippedNotPage++;
      continue;
    }
    if (seen.has(page.key)) {
      skippedDuplicate++;
      continue;
    }
    seen.add(page.key);
    if (existingKeys.has(page.key)) {
      skippedKnown++;
      continue;
    }
    pages.push({
      ...page,
      title: String(hit.title || "").trim(),
      snippet: String(hit.content || "").trim().slice(0, 1000),
      query: hit.query,
      provider: hit.provider,
    });
  }
  return { pages, skippedNotPage, skippedDuplicate, skippedKnown };
}

/**
 * Runs every query on every configured provider at the same time and keeps the first
 * `targetCount` unique new Pages. A provider failure never fails the run.
 */
export async function discoverPages(
  spec: BusinessSearchSpec,
  options: {
    targetCount: number;
    existingKeys?: Set<string>;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  },
  deps: DiscoverDeps,
) {
  const queries = buildDiscoveryQueries(spec);
  const providers = (
    [
      ["tavily", deps.tavilySearch],
      ["brightdata", deps.brightDataSearch],
    ] as const
  ).filter(([, fn]) => typeof fn === "function");

  const errors: string[] = [];
  const settled = await Promise.all(
    queries.flatMap((query) =>
      providers.map(async ([provider, fn]) => {
        if (options.signal?.aborted) return [];
        try {
          const results = await fn!(query, options.signal);
          return (results || []).map((hit) => ({ ...hit, query, provider }));
        } catch (error) {
          errors.push(`${provider}: ${(error as Error)?.message || String(error)}`);
          return [];
        }
      }),
    ),
  );
  const hits = settled.flat();
  const filtered = filterPageHits(hits, options.existingKeys);
  options.onProgress?.(
    `Searched ${queries.length} queries on ${providers.length} provider(s): ${hits.length} results, ${filtered.pages.length} new Facebook Pages.`,
  );
  return {
    queries,
    totalHits: hits.length,
    errors,
    ...filtered,
    pages: filtered.pages.slice(0, Math.max(1, options.targetCount)),
  };
}
