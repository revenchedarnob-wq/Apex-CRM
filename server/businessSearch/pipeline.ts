import crypto from "crypto";
import type { BusinessDetails } from "../../src/types.js";
import { parseBusinessBrief, type BusinessSearchSpec } from "./brief.js";
import type { CoverageEstimate } from "./coverage.js";
import { describeCoverage } from "./coverage.js";
import type { DiscoveredPage } from "./discover.js";
import { readFacebookPages, type FetchLike, type PageCache } from "./facebookPages.js";
import { addressCountry, checkPlaceMatch, splitPlaceAndCountry, type AreaPlace } from "./places.js";
import { extractOwnerName, qualifyBusiness, type Qualification } from "./qualify.js";
import { collectCandidates, type Candidate, type CollectDeps, type CollectStats } from "./rounds.js";

export type BusinessSearchInput = {
  query: string;
  /** How many businesses to return (1-100). */
  limit: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

export type BusinessSearchDeps = CollectDeps & {
  brightDataToken?: string;
  fetchImpl?: FetchLike;
  pageCache?: PageCache;
  existingKeys?: Set<string>;
  pagesMaxWaitMs?: number;
  pagesPollMs?: number;
  /** Saves leads; returns how many were new vs already in the CRM. */
  persist?: (leads: Record<string, any>[]) => { created: number; updated: number; duplicates: number };
};

export type BusinessSearchResult = {
  spec: BusinessSearchSpec;
  leads: Record<string, any>[];
  rejected: Array<{ name: string; pageUrl?: string; reasons: string[] }>;
  stats: {
    queries: number;
    searchResults: number;
    pagesFound: number;
    skippedKnown: number;
    pagesRead: number;
    pagesFromCache: number;
    pagesFailed: number;
    qualified: number;
    maybe: number;
    rejected: number;
    saved?: { created: number; updated: number; duplicates: number };
    searchErrors: string[];
    durationMs: number;
    /** Where Pages came from and how much of the area was covered. */
    rounds: Omit<CollectStats, "searchErrors" | "searchResults" | "skippedKnown">;
    area?: { name: string; release?: string; fromCache: boolean };
    coverage: CoverageEstimate | null;
  };
};

/**
 * Business name from a search result title such as "Sweet Crumbs - Home | Facebook" or
 * "Sweet Crumbs | Manchester | Facebook" (Facebook puts the city between name and suffix).
 */
export function nameFromSearchTitle(title: string): string {
  const segments = title.split(/\s+\|\s+/);
  const withCity = segments.length >= 3 && /^facebook$/i.test(segments[segments.length - 1].trim());
  return (withCity ? segments[0] : title)
    .replace(/\s*[|\-\u2013]\s*Facebook\s*$/i, "")
    .replace(/\s*[|\-\u2013]\s*(?:Home|About|Posts|Photos|Reviews)\s*$/i, "")
    .replace(/\s*\|\s*Facebook.*$/i, "")
    .trim();
}

/** Search-snippet stand-in used when a Page could not be read from Bright Data. */
export function businessFromSearchHit(page: DiscoveredPage, place?: AreaPlace): BusinessDetails | null {
  if (place) {
    return mergePlaceDetails(
      {
        name: place.name,
        pageUrl: page.url,
        pageId: page.pageId,
        username: page.username,
        category: place.categories[0],
        about: page.snippet || undefined,
        dataQuality: "partial",
        fetchedAt: new Date().toISOString(),
      },
      place,
    );
  }
  const name = nameFromSearchTitle(page.title);
  if (!name) return null;
  return {
    name,
    pageUrl: page.url,
    pageId: page.pageId,
    username: page.username,
    about: page.snippet || undefined,
    dataQuality: "partial",
    fetchedAt: new Date().toISOString(),
  };
}

/** Fills contact and address gaps on a Page from its map listing. Page data wins where both exist. */
export function mergePlaceDetails(business: BusinessDetails, place: AreaPlace): BusinessDetails {
  const merged: BusinessDetails = { ...business };
  if (!merged.phones?.length && place.phones.length) merged.phones = place.phones;
  if (!merged.websites?.length && place.websites.length) merged.websites = place.websites;
  if (!merged.emails?.length && place.emails.length) merged.emails = place.emails;
  if (!merged.address && place.address) merged.address = place.address;
  if (!merged.city && place.city) merged.city = place.city;
  if (!merged.country && place.country) merged.country = place.country;
  if (!merged.category && place.categories[0]) merged.category = place.categories[0];
  return merged;
}

const VIA_LABEL: Record<Candidate["via"][number], string> = {
  map: "Found in map data",
  website: "Found on the business website",
  name: "Found by name from the map listing",
  search: "Found by web search",
  "area-search": "Found by area search",
};

export function businessLeadId(pageKey: string): string {
  return `biz-${crypto.createHash("sha256").update(pageKey).digest("hex").slice(0, 24)}`;
}

/** Builds a CRM lead from a qualified business. Fills profile fields so every existing view works. */
export function buildBusinessLead(
  pageKey: string,
  business: BusinessDetails,
  qualification: Qualification,
  spec: BusinessSearchSpec,
  now = new Date().toISOString(),
): Record<string, any> {
  const owner = business.ownerName ? null : extractOwnerName(business.about);
  const withOwner: BusinessDetails = owner
    ? { ...business, ownerName: owner.name, ownerSource: "page", ownerConfidence: owner.confidence }
    : business;
  const id = businessLeadId(pageKey);
  return {
    id,
    kind: "business",
    source: "facebook",
    business: withOwner,
    profile: {
      id: `profile-${id}`,
      fullName: withOwner.name,
      currentCompany: withOwner.name,
      currentTitle: withOwner.category || "",
      headline: withOwner.category || "",
      location: withOwner.city || withOwner.address || "",
      industry: withOwner.category || "",
      summary: withOwner.about || "",
      contactDetails: {
        email: withOwner.emails?.[0],
        phone: withOwner.phones?.[0],
        website: withOwner.websites?.[0],
      },
    },
    stage: "SCRAPED",
    reviewStatus: qualification.verdict === "maybe" ? "MAYBE" : "UNREVIEWED",
    nextAction: "OPEN_FACEBOOK",
    sourceProvider: "brightdata",
    evidenceReasons: qualification.reasons,
    qualificationScore: qualification.score,
    compositeScore: qualification.score,
    evidence: {
      sourceQuery: spec.brief,
      sourceUrl: withOwner.pageUrl,
    },
    tags: ["facebook"],
    createdAt: now,
  };
}

/**
 * Finds businesses through their public Facebook Pages:
 * brief -> collect Page links in rounds, cheapest first (free map data, web search,
 * business websites, name lookups, area searches; see rounds.ts) -> read Pages
 * (Bright Data, cached) -> check each Page against its map listing -> rules-based
 * qualification -> owner name from Page text -> save, with a coverage estimate.
 */
export async function runBusinessSearch(
  input: BusinessSearchInput,
  deps: BusinessSearchDeps,
): Promise<BusinessSearchResult> {
  const started = Date.now();
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit || 25)));
  const spec = parseBusinessBrief(input.query);
  if (spec.categoryTerms.length === 0) {
    throw new Error('Say what kind of business to find, for example "bakeries in Manchester".');
  }
  input.onProgress?.(
    `Looking for ${spec.categoryTerms.join(" ")}${spec.place ? ` in ${spec.place}` : ""}${spec.minFollowers ? ` with ${spec.minFollowers}+ followers` : ""}.`,
  );

  // Collect about 1.5x the target so rejections still leave enough results.
  const collected = await collectCandidates(
    spec,
    { target: Math.ceil(limit * 1.5), existingKeys: deps.existingKeys, signal: input.signal, onProgress: input.onProgress },
    deps,
  );
  const pages = collected.candidates;
  input.onProgress?.(`Found ${pages.length} new Facebook Pages to check.`);

  let readResults: Awaited<ReturnType<typeof readFacebookPages>> = {
    results: pages.map((page) => ({ key: page.key, error: "Bright Data is not configured" })),
    cached: 0,
    fetched: 0,
    failed: 0,
  };
  if (deps.brightDataToken && pages.length > 0) {
    readResults = await readFacebookPages(pages, {
      token: deps.brightDataToken,
      cache: deps.pageCache,
      fetchImpl: deps.fetchImpl,
      signal: input.signal,
      maxWaitMs: deps.pagesMaxWaitMs,
      pollMs: deps.pagesPollMs,
      onProgress: input.onProgress,
    });
  } else if (pages.length > 0) {
    input.onProgress?.("Bright Data token not set, so Pages are judged from search results and map data only.");
  }

  const wantedCountry = collected.area?.country || splitPlaceAndCountry(spec.place).country;
  const now = new Date().toISOString();
  const accepted: Array<{ lead: Record<string, any>; score: number }> = [];
  const rejected: BusinessSearchResult["rejected"] = [];
  let qualified = 0;
  let maybe = 0;
  pages.forEach((page, index) => {
    const read = readResults.results[index];
    let business = read?.business || businessFromSearchHit(page, page.place);
    if (!business) return;
    const sourceReasons = page.via.map((via) => VIA_LABEL[via]).filter((label, i, all) => all.indexOf(label) === i);
    if (page.place) {
      // Pages found by name must prove they are the listed business; map and website links already do.
      if (read?.business && !page.via.some((via) => via === "map" || via === "website")) {
        const match = checkPlaceMatch(page.place, business);
        if (match.level === "conflict") {
          rejected.push({ name: business.name, pageUrl: business.pageUrl, reasons: match.reasons });
          return;
        }
        sourceReasons.push(...match.reasons.map((reason) => reason.charAt(0).toUpperCase() + reason.slice(1)));
      }
      business = mergePlaceDetails(business, page.place);
    }
    const country = addressCountry(business.address);
    if (wantedCountry && country && country !== wantedCountry) {
      rejected.push({ name: business.name, pageUrl: business.pageUrl, reasons: [`Address is in ${country}, not ${wantedCountry}: ${business.address}`] });
      return;
    }
    const qualification = qualifyBusiness(business, spec);
    if (qualification.verdict === "rejected") {
      rejected.push({ name: business.name, pageUrl: business.pageUrl, reasons: qualification.reasons });
      return;
    }
    if (qualification.verdict === "qualified") qualified++;
    else maybe++;
    // Pages tied to a map listing are the most certain, so they rank a little higher.
    const bonus = page.place ? 0.5 : 0;
    const withSources: Qualification = { ...qualification, reasons: [...sourceReasons, ...qualification.reasons] };
    accepted.push({
      lead: buildBusinessLead(page.key, business, withSources, spec, now),
      score: qualification.score + bonus,
    });
  });

  const leads = accepted
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.lead);
  const saved = deps.persist && leads.length > 0 ? deps.persist(leads) : undefined;
  if (collected.area) input.onProgress?.(describeCoverage(collected.coverage));
  input.onProgress?.(
    `Done: ${leads.length} businesses (${qualified} qualified, ${maybe} to review), ${rejected.length} rejected.`,
  );

  return {
    spec,
    leads,
    rejected,
    stats: {
      queries: collected.queries.length,
      searchResults: collected.stats.searchResults,
      pagesFound: pages.length,
      skippedKnown: collected.stats.skippedKnown,
      pagesRead: readResults.fetched,
      pagesFromCache: readResults.cached,
      pagesFailed: readResults.failed,
      qualified,
      maybe,
      rejected: rejected.length,
      saved,
      searchErrors: collected.stats.searchErrors,
      durationMs: Date.now() - started,
      rounds: {
        mapPlaces: collected.stats.mapPlaces,
        mapLinked: collected.stats.mapLinked,
        websitesChecked: collected.stats.websitesChecked,
        websiteLinked: collected.stats.websiteLinked,
        nameLookups: collected.stats.nameLookups,
        nameMatched: collected.stats.nameMatched,
        searchQueries: collected.stats.searchQueries,
        areaQueries: collected.stats.areaQueries,
      },
      area: collected.area
        ? { name: collected.area.areaName, release: collected.area.release, fromCache: collected.area.fromCache }
        : undefined,
      coverage: collected.coverage,
    },
  };
}
