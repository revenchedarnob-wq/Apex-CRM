import crypto from "crypto";
import type { BusinessDetails } from "../../src/types.js";
import { parseBusinessBrief, type BusinessSearchSpec } from "./brief.js";
import { buildBusinessIdentityKeys, canonicalFacebookPage } from "../../src/utils/leadDedupe.js";
import type { CoverageEstimate } from "./coverage.js";
import { describeCoverage } from "./coverage.js";
import type { DiscoveredPage } from "./discover.js";
import { readFacebookPages, type FetchLike, type PageCache } from "./facebookPages.js";
import { judgeBusinesses, readBriefWithAi, type AiCall } from "./aiJudge.js";
import { addressCountry, checkPlaceMatch, splitPlaceAndCountry, type AreaPlace } from "./places.js";
import { extractOwnerName, qualifyBusiness, type Qualification } from "./qualify.js";
import { collectCandidates, type Candidate, type CollectDeps, type CollectStats } from "./rounds.js";

export type BusinessSearchInput = {
  query: string;
  /** How many businesses to return (1-100). */
  limit: number;
  /**
   * Also keep map-listed businesses with no Facebook Page (up to `limit` more), with
   * their phone, website and address from the map data. On unless set to false.
   */
  includeMapOnly?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

export type BusinessSearchDeps = CollectDeps & {
  /** Reads the brief and judges businesses against it. Optional: rules only without it. */
  ai?: AiCall;
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
    /** Map-listed businesses kept without a Facebook Page. */
    mapOnly: number;
    /** Businesses the AI checked against the brief's own-words requirements, and how many it ruled out. */
    ai: { requirements: string[]; judged: number; rejected: number; error?: string };
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
 * Builds a lead for a business the map data lists but no Facebook Page was found for.
 * Its contact details come from the map listing, so it can still be called or emailed.
 */
export function buildMapOnlyLead(
  place: AreaPlace,
  checked: boolean,
  spec: BusinessSearchSpec,
  now = new Date().toISOString(),
): { lead: Record<string, any>; score: number } | null {
  const business = mergePlaceDetails({ name: place.name, dataQuality: "full", fetchedAt: now }, place);
  if (!business.phones?.length && !business.emails?.length && !business.websites?.length) return null;
  const qualification = qualifyBusiness(business, spec);
  if (qualification.verdict === "rejected") return null;
  const reasons = [
    "Found in map data",
    checked ? "No Facebook Page found (website and name search checked)" : "Facebook not checked (search stopped at its target)",
    ...qualification.reasons.map((reason) => reason.replace(/ on the Page$/, "")),
  ];
  const lead = buildBusinessLead(`place:${place.id}`, business, { ...qualification, reasons }, spec, now);
  lead.source = "maps";
  lead.nextAction = business.phones?.length ? "CALL" : business.emails?.length ? "EMAIL" : "RESEARCH";
  lead.tags = [checked ? "no-facebook" : "facebook-unchecked"];
  lead.evidence = { sourceQuery: spec.brief, sourceUrl: business.websites?.[0] };
  delete lead.sourceProvider;
  // Checked businesses first: they are known to have no Page.
  return { lead, score: qualification.score + (checked ? 0.5 : 0) + (place.brand ? -1 : 0) };
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
  let limit = Math.max(1, Math.min(100, Math.floor(input.limit || 25)));
  let spec = parseBusinessBrief(input.query);
  let aiError: string | undefined;
  if (deps.ai) {
    try {
      spec = await readBriefWithAi(spec, deps.ai, input.signal);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      aiError = (error as Error)?.message || String(error);
      input.onProgress?.("The AI could not read the request, so the simple reader is used and nothing is AI-checked.");
    }
  }
  if (spec.categoryTerms.length === 0) {
    throw new Error('Say what kind of business to find, for example "bakeries in Manchester".');
  }
  input.onProgress?.(
    `Looking for ${spec.categoryTerms.join(" ")}${spec.place ? ` in ${spec.place}` : ""}${spec.minFollowers ? ` with ${spec.minFollowers}+ followers` : ""}.`,
  );
  if (spec.requestedCount && spec.requestedCount !== limit) {
    limit = spec.requestedCount;
    input.onProgress?.(`Your request asks for ${limit}, so up to ${limit} are returned.`);
  }
  if (spec.synonyms?.length) input.onProgress?.(`Also searching as: ${spec.synonyms.join(", ")}.`);
  if (spec.requirements?.length) input.onProgress?.(`The AI will check: ${spec.requirements.join("; ")}.`);

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
    if (!business.pageUrl || !canonicalFacebookPage(business.pageUrl)) business = { ...business, pageUrl: page.url };
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

  accepted.sort((a, b) => b.score - a.score);

  // Businesses on the map with no Facebook Page still have a phone or website, so keep
  // them too, after the Facebook ones. Skipped when the brief asks for followers, which
  // only a Page has.
  const mapOnlyPool: Array<{ lead: Record<string, any>; score: number }> = [];
  if (input.includeMapOnly !== false && spec.minFollowers === 0 && collected.placesWithoutPage.length) {
    const known = deps.existingKeys || new Set<string>();
    const taken = new Set<string>();
    for (const entry of accepted) for (const key of buildBusinessIdentityKeys(entry.lead.business)) taken.add(key);
    const extra = collected.placesWithoutPage
      .map(({ place, checked }) => buildMapOnlyLead(place, checked, spec, now))
      .filter((entry): entry is { lead: Record<string, any>; score: number } => Boolean(entry))
      .sort((a, b) => b.score - a.score);
    for (const entry of extra) {
      if (mapOnlyPool.length >= Math.ceil(limit * 1.5)) break;
      const keys = Array.from(buildBusinessIdentityKeys(entry.lead.business));
      if (keys.some((key) => known.has(key) || taken.has(key))) continue;
      keys.forEach((key) => taken.add(key));
      mapOnlyPool.push(entry);
    }
  }

  // The AI checks businesses that passed the rules: the trade, the place and the brief's
  // own-words requirements.
  const aiStats: BusinessSearchResult["stats"]["ai"] = { requirements: spec.requirements || [], judged: 0, rejected: 0, error: aiError };
  let fbKept = accepted;
  let mapKept = mapOnlyPool;
  // With own-words requirements every business is checked; otherwise only the ones the
  // rules could not settle ("to review"), so a plain search costs no judge calls.
  const needsJudging = (entry: { lead: Record<string, any> }) =>
    Boolean(spec.requirements?.length) || entry.lead.reviewStatus === "MAYBE";
  const pool = deps.ai ? [...accepted, ...mapOnlyPool].filter(needsJudging) : [];
  if (deps.ai && pool.length > 0) {
    input.onProgress?.(`The AI is checking ${pool.length} businesses against your request.`);
    const verdicts = await judgeBusinesses(
      spec,
      pool.map((entry) => ({ id: entry.lead.id, business: entry.lead.business, onFacebook: entry.lead.source !== "maps" })),
      deps.ai,
      {
        signal: input.signal,
        onError: (error) => {
          aiStats.error = (error as Error)?.message || String(error);
        },
      },
    );
    const judge = (entry: { lead: Record<string, any>; score: number }) => {
      const verdict = verdicts.get(entry.lead.id);
      if (!verdict) return true;
      aiStats.judged++;
      const reason = `AI check: ${verdict.reason || verdict.verdict}`;
      if (verdict.verdict === "no") {
        aiStats.rejected++;
        rejected.push({ name: entry.lead.business.name, pageUrl: entry.lead.business.pageUrl, reasons: [reason] });
        return false;
      }
      entry.lead.evidenceReasons = [reason, ...(entry.lead.evidenceReasons || [])];
      if (verdict.verdict === "match") {
        entry.score += 1.5;
        // The AI settled what the rules could not.
        if (entry.lead.reviewStatus === "MAYBE") entry.lead.reviewStatus = "UNREVIEWED";
      } else {
        entry.score -= 0.5;
        entry.lead.reviewStatus = "MAYBE";
      }
      return true;
    };
    fbKept = accepted.filter(judge).sort((a, b) => b.score - a.score);
    mapKept = mapOnlyPool.filter(judge).sort((a, b) => b.score - a.score);
    if (aiStats.error && aiStats.judged === 0) input.onProgress?.("The AI check failed, so the rules result is used.");
  }

  const leads = fbKept.slice(0, limit).map((entry) => entry.lead);
  qualified = leads.filter((lead) => lead.reviewStatus !== "MAYBE").length;
  maybe = leads.length - qualified;
  const mapOnlyLeads = mapKept.slice(0, limit).map((entry) => entry.lead);
  const mapOnly = mapOnlyLeads.length;
  leads.push(...mapOnlyLeads);
  if (mapOnly) input.onProgress?.(`Also kept ${mapOnly} businesses from the map with no Facebook Page, with their phone or website.`);
  const saved = deps.persist && leads.length > 0 ? deps.persist(leads) : undefined;
  if (collected.area) input.onProgress?.(describeCoverage(collected.coverage));
  input.onProgress?.(
    `Done: ${leads.length - mapOnly} businesses on Facebook (${qualified} qualified, ${maybe} to review), ${rejected.length} rejected${mapOnly ? `, plus ${mapOnly} without a Facebook Page` : ""}.`,
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
      mapOnly,
      ai: aiStats,
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
