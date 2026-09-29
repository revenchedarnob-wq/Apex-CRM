import type { FacebookPageRef } from "../../src/utils/leadDedupe.js";
import type { BusinessSearchSpec } from "./brief.js";
import { estimateCoverage, type CoverageEstimate } from "./coverage.js";
import { discoverPages, filterPageHits, type DiscoverDeps, type DiscoveredPage, type SearchHit } from "./discover.js";
import type { FetchLike } from "./facebookPages.js";
import { areaNamesFromPlaces, buildAreaQueries, buildNameLookupQuery, pickLookupHit } from "./lookup.js";
import type { AreaLoad, AreaPlace, AreaSource } from "./places.js";
import { findFacebookOnWebsite, isCheckableWebsite, mapWithConcurrency } from "./websiteLinks.js";

/** How a Page was found. Map, website and name are "from the business list"; the rest are web search. */
export type FoundVia = "map" | "website" | "name" | "search" | "area-search";

export type Candidate = DiscoveredPage & {
  via: FoundVia[];
  /** The map listing this Page belongs to, when it was found from the business list. */
  place?: AreaPlace;
};

export type CollectDeps = DiscoverDeps & {
  /** Free business list for an area (Overture map data). Optional. */
  areaSource?: AreaSource;
  /** Used to open business websites and look for their Facebook link. Optional. */
  websiteFetch?: FetchLike;
  maxWebsiteChecks?: number;
  maxNameLookups?: number;
  maxAreaQueries?: number;
};

export type CollectStats = {
  mapPlaces: number;
  mapLinked: number;
  websitesChecked: number;
  websiteLinked: number;
  nameLookups: number;
  nameMatched: number;
  searchQueries: number;
  areaQueries: number;
  searchResults: number;
  skippedKnown: number;
  searchErrors: string[];
};

export type CollectResult = {
  /** New Pages to read, best-evidenced first, at most `target`. */
  candidates: Candidate[];
  area: AreaLoad | null;
  coverage: CoverageEstimate | null;
  queries: string[];
  stats: CollectStats;
};

const LIST_VIA = new Set<FoundVia>(["map", "website", "name"]);
const VIA_ORDER: FoundVia[] = ["map", "website", "name", "search", "area-search"];

/**
 * Collects Facebook Pages for a brief in rounds, cheapest first, and stops as soon as
 * there are enough new Pages, the same way the LinkedIn search stops at its target:
 *
 * 1. free map data: businesses of the trade in the area, many already linking a Page
 * 2. web search for Pages (the original discovery, also used for the coverage meter)
 * 3. free: open business websites that have no Page yet and look for a Facebook link
 * 4. paid, cheap: search each remaining business by name
 * 5. paid, cheap: area-by-area searches for businesses no map lists
 */
export async function collectCandidates(
  spec: BusinessSearchSpec,
  options: { target: number; existingKeys?: Set<string>; signal?: AbortSignal; onProgress?: (message: string) => void },
  deps: CollectDeps,
): Promise<CollectResult> {
  const target = Math.max(1, options.target);
  const known = options.existingKeys || new Set<string>();
  const progress = options.onProgress || (() => undefined);
  const pages = new Map<string, Candidate>();
  const listKeys = new Set<string>();
  const searchKeys = new Set<string>();
  const stats: CollectStats = {
    mapPlaces: 0, mapLinked: 0, websitesChecked: 0, websiteLinked: 0, nameLookups: 0, nameMatched: 0,
    searchQueries: 0, areaQueries: 0, searchResults: 0, skippedKnown: 0, searchErrors: [],
  };
  const queries: string[] = [];
  const linkedPlaceIds = new Set<string>();

  const newCount = () => Array.from(pages.keys()).filter((key) => !known.has(key)).length;
  const enough = () => newCount() >= target || Boolean(options.signal?.aborted);
  const add = (page: FacebookPageRef & Partial<DiscoveredPage>, via: FoundVia, place?: AreaPlace) => {
    const existing = pages.get(page.key);
    if (existing) {
      if (!existing.via.includes(via)) existing.via.push(via);
      if (!existing.place && place) existing.place = place;
    } else {
      pages.set(page.key, {
        key: page.key,
        url: page.url,
        pageId: page.pageId,
        username: page.username,
        title: page.title || place?.name || "",
        snippet: page.snippet || "",
        query: page.query || "",
        provider: page.provider || "tavily",
        via: [via],
        place,
      });
    }
    if (place) linkedPlaceIds.add(place.id);
    (LIST_VIA.has(via) ? listKeys : searchKeys).add(page.key);
  };
  const searchFn = deps.brightDataSearch || deps.tavilySearch;
  const searchProvider: DiscoveredPage["provider"] = deps.brightDataSearch ? "brightdata" : "tavily";

  // Round 1: map data.
  let area: AreaLoad | null = null;
  if (deps.areaSource) {
    try {
      area = await deps.areaSource.load(spec, { signal: options.signal, onProgress: progress });
    } catch (error) {
      progress(`Map data failed (${(error as Error)?.message || error}), so only web search is used.`);
    }
  }
  const places = area?.places || [];
  stats.mapPlaces = places.length;
  for (const place of places) {
    const page = place.facebookPages[0];
    if (page) {
      add({ ...page, title: place.name }, "map", place);
      stats.mapLinked++;
    }
  }
  if (area) {
    progress(
      `Map data${area.fromCache ? " (saved copy)" : ""}: ${places.length} businesses in ${area.areaName}, ${stats.mapLinked} already link a Facebook Page.`,
    );
  }

  // Round 2: web search for Pages. Always runs: it finds Pages no map lists, and its
  // overlap with the map data is what the coverage meter measures.
  if (!options.signal?.aborted && (deps.tavilySearch || deps.brightDataSearch)) {
    const discovery = await discoverPages(
      spec,
      { targetCount: 1000, existingKeys: new Set(), signal: options.signal, onProgress: progress },
      deps,
    );
    queries.push(...discovery.queries);
    stats.searchQueries += discovery.queries.length;
    stats.searchResults += discovery.totalHits;
    stats.searchErrors.push(...discovery.errors);
    discovery.pages.forEach((page) => add(page, "search"));
  }

  const unlinked = places.filter((place) => !linkedPlaceIds.has(place.id));

  // Round 3: business websites (free).
  if (!enough() && deps.websiteFetch && unlinked.length) {
    const withSite = unlinked
      .filter((place) => place.websites.some(isCheckableWebsite))
      .slice(0, deps.maxWebsiteChecks ?? 60);
    if (withSite.length) {
      progress(`Checking ${withSite.length} business websites for their Facebook Page (free).`);
      await mapWithConcurrency(
        withSite,
        4,
        async (place) => {
          stats.websitesChecked++;
          for (const site of place.websites.filter(isCheckableWebsite).slice(0, 1)) {
            const page = await findFacebookOnWebsite(site, { fetchImpl: deps.websiteFetch!, signal: options.signal });
            if (page) {
              add({ ...page, title: place.name }, "website", place);
              stats.websiteLinked++;
              return;
            }
          }
        },
        enough,
      );
    }
  }

  // Round 4: look up each remaining business by name.
  const stillUnlinked = unlinked.filter((place) => !linkedPlaceIds.has(place.id));
  if (!enough() && searchFn && stillUnlinked.length) {
    const batch = stillUnlinked.slice(0, deps.maxNameLookups ?? Math.min(80, target * 2));
    progress(`Looking up ${batch.length} businesses from the map by name.`);
    await mapWithConcurrency(
      batch,
      4,
      async (place) => {
        const query = buildNameLookupQuery(place, spec.place);
        stats.nameLookups++;
        queries.push(query);
        let hits: SearchHit[] = [];
        try {
          hits = await searchFn(query, options.signal);
        } catch (error) {
          stats.searchErrors.push(`${searchProvider}: ${(error as Error)?.message || error}`);
          return;
        }
        stats.searchResults += hits.length;
        const match = pickLookupHit(place, hits);
        if (match) {
          add({ ...match, query, provider: searchProvider }, "name", place);
          stats.nameMatched++;
        }
      },
      enough,
    );
  }

  // Round 5: area-by-area searches, for businesses that are on Facebook but on no map.
  if (!enough() && searchFn && places.length) {
    const areaQueries = buildAreaQueries(spec, areaNamesFromPlaces(places, spec), deps.maxAreaQueries ?? 12);
    if (areaQueries.length) progress(`Searching ${areaQueries.length} smaller areas for Pages the map does not list.`);
    for (const query of areaQueries) {
      if (enough()) break;
      stats.areaQueries++;
      queries.push(query);
      try {
        const hits = await searchFn(query, options.signal);
        stats.searchResults += hits.length;
        const filtered = filterPageHits(hits.map((hit) => ({ ...hit, query, provider: searchProvider })));
        filtered.pages.forEach((page) => add(page, "area-search"));
      } catch (error) {
        stats.searchErrors.push(`${searchProvider}: ${(error as Error)?.message || error}`);
      }
    }
  }

  const all = Array.from(pages.values());
  stats.skippedKnown = all.filter((candidate) => known.has(candidate.key)).length;
  const rank = (candidate: Candidate) => Math.min(...candidate.via.map((via) => VIA_ORDER.indexOf(via)));
  const candidates = all
    .filter((candidate) => !known.has(candidate.key))
    .sort((a, b) => rank(a) - rank(b) || b.via.length - a.via.length)
    .slice(0, target);
  const coverage = area ? estimateCoverage(listKeys, searchKeys) : null;
  return { candidates, area, coverage, queries, stats };
}
