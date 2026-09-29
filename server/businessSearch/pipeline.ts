import crypto from "crypto";
import type { BusinessDetails } from "../../src/types.js";
import { parseBusinessBrief, type BusinessSearchSpec } from "./brief.js";
import { discoverPages, type DiscoverDeps, type DiscoveredPage } from "./discover.js";
import { readFacebookPages, type FetchLike, type PageCache } from "./facebookPages.js";
import { extractOwnerName, qualifyBusiness, type Qualification } from "./qualify.js";

export type BusinessSearchInput = {
  query: string;
  /** How many businesses to return (1-100). */
  limit: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

export type BusinessSearchDeps = DiscoverDeps & {
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
    .replace(/\s*[|\-–]\s*Facebook\s*$/i, "")
    .replace(/\s*[|\-–]\s*(?:Home|About|Posts|Photos|Reviews)\s*$/i, "")
    .replace(/\s*\|\s*Facebook.*$/i, "")
    .trim();
}

/** Search-snippet stand-in used when a Page could not be read from Bright Data. */
export function businessFromSearchHit(page: DiscoveredPage): BusinessDetails | null {
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
 * brief -> search for Page links -> filter (no LLM) -> read Pages (Bright Data, cached)
 * -> rules-based qualification -> owner name from Page text -> save.
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

  // Read about 1.5x the target so rejections still leave enough results.
  const discovery = await discoverPages(
    spec,
    {
      targetCount: Math.ceil(limit * 1.5),
      existingKeys: deps.existingKeys,
      signal: input.signal,
      onProgress: input.onProgress,
    },
    deps,
  );

  let readResults: Awaited<ReturnType<typeof readFacebookPages>> = {
    results: discovery.pages.map((page) => ({ key: page.key, error: "Bright Data is not configured" })),
    cached: 0,
    fetched: 0,
    failed: 0,
  };
  if (deps.brightDataToken && discovery.pages.length > 0) {
    readResults = await readFacebookPages(discovery.pages, {
      token: deps.brightDataToken,
      cache: deps.pageCache,
      fetchImpl: deps.fetchImpl,
      signal: input.signal,
      maxWaitMs: deps.pagesMaxWaitMs,
      pollMs: deps.pagesPollMs,
      onProgress: input.onProgress,
    });
  } else if (discovery.pages.length > 0) {
    input.onProgress?.("Bright Data token not set, so Pages are judged from search results only.");
  }

  const now = new Date().toISOString();
  const accepted: Array<{ lead: Record<string, any>; score: number }> = [];
  const rejected: BusinessSearchResult["rejected"] = [];
  let qualified = 0;
  let maybe = 0;
  discovery.pages.forEach((page, index) => {
    const read = readResults.results[index];
    const business = read?.business || businessFromSearchHit(page);
    if (!business) return;
    const qualification = qualifyBusiness(business, spec);
    if (qualification.verdict === "rejected") {
      rejected.push({ name: business.name, pageUrl: business.pageUrl, reasons: qualification.reasons });
      return;
    }
    if (qualification.verdict === "qualified") qualified++;
    else maybe++;
    accepted.push({
      lead: buildBusinessLead(page.key, business, qualification, spec, now),
      score: qualification.score,
    });
  });

  const leads = accepted
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.lead);
  const saved = deps.persist && leads.length > 0 ? deps.persist(leads) : undefined;
  input.onProgress?.(
    `Done: ${leads.length} businesses (${qualified} qualified, ${maybe} to review), ${rejected.length} rejected.`,
  );

  return {
    spec,
    leads,
    rejected,
    stats: {
      queries: discovery.queries.length,
      searchResults: discovery.totalHits,
      pagesFound: discovery.pages.length,
      skippedKnown: discovery.skippedKnown,
      pagesRead: readResults.fetched,
      pagesFromCache: readResults.cached,
      pagesFailed: readResults.failed,
      qualified,
      maybe,
      rejected: rejected.length,
      saved,
      searchErrors: discovery.errors,
      durationMs: Date.now() - started,
    },
  };
}
