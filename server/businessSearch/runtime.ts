import { fetch as undiciFetch } from "undici";
import type { BusinessDetails } from "../../src/types.js";
import {
  getEnrichmentCacheEntry,
  readExistingIdentityKeys,
  upsertEnrichmentCacheEntry,
  upsertLeadsWithIdentity,
} from "../db.js";
import { brightDataSearch, isBrightDataConfigured } from "../services/brightdata.js";
import { parseApiKeys } from "../services/keyRotator.js";
import { hasTavilyKey, tavilySearch } from "../services/llm.js";
import { ssrfSafeDispatcher } from "../leadSearch/siteProbe.js";
import type { FetchLike, PageCache } from "./facebookPages.js";
import { createOvertureAreaSource, loadDuckDbQueryRunner, type AreaCache, type QueryRunner } from "./overture.js";
import type { AreaLoad } from "./places.js";
import type { BusinessSearchDeps } from "./pipeline.js";

const PAGE_CACHE_PROVIDER = "brightdata_facebook_page";
const PAGE_CACHE_TTL_DAYS = 30;

/** Facebook Page records live in the shared enrichment cache for 30 days. */
export const enrichmentPageCache: PageCache = {
  get(key) {
    const entry = getEnrichmentCacheEntry({ normalizedUrl: key });
    if (!entry || entry.sourceProvider !== PAGE_CACHE_PROVIDER) return null;
    try {
      const parsed = JSON.parse(entry.evidenceBlock) as BusinessDetails;
      return parsed && typeof parsed.name === "string" ? parsed : null;
    } catch {
      return null;
    }
  },
  set(key, business) {
    upsertEnrichmentCacheEntry(
      {
        normalizedUrl: key,
        companyName: business.name,
        evidenceBlock: JSON.stringify(business),
        scrapeQuality: "good",
        sourceProvider: PAGE_CACHE_PROVIDER,
      },
      PAGE_CACHE_TTL_DAYS,
    );
  },
};

const AREA_CACHE_PROVIDER = "overture_area";
// Overture publishes a new release every month.
const AREA_CACHE_TTL_DAYS = 30;

/** Area business lists live in the shared enrichment cache, so a second search of an area is free. */
export const enrichmentAreaCache: AreaCache = {
  get(key) {
    const entry = getEnrichmentCacheEntry({ normalizedUrl: key });
    if (!entry || entry.sourceProvider !== AREA_CACHE_PROVIDER) return null;
    try {
      const parsed = JSON.parse(entry.evidenceBlock) as AreaLoad;
      return parsed && Array.isArray(parsed.places) ? parsed : null;
    } catch {
      return null;
    }
  },
  set(key, load) {
    upsertEnrichmentCacheEntry(
      {
        normalizedUrl: key,
        companyName: load.areaName,
        evidenceBlock: JSON.stringify({ ...load, fromCache: false }),
        scrapeQuality: "good",
        sourceProvider: AREA_CACHE_PROVIDER,
      },
      AREA_CACHE_TTL_DAYS,
    );
  },
};

/** Fetch for business websites that refuses private and internal addresses, redirects included. */
const safeWebsiteFetch: FetchLike = (url, init) =>
  undiciFetch(url, { ...(init as any), dispatcher: ssrfSafeDispatcher }) as unknown as Promise<Response>;

// One DuckDB connection for the whole app, opened on first use.
let duckDbRunner: Promise<QueryRunner | null> | null = null;
const getDuckDbRunner = () => {
  duckDbRunner ??= loadDuckDbQueryRunner().catch(() => null);
  return duckDbRunner;
};

export function isMapDataEnabled(): boolean {
  return !/^(?:0|false|off|no)$/i.test(String(process.env.BUSINESS_MAP_DATA || "").trim());
}

export function getBrightDataApiToken(): string | undefined {
  return parseApiKeys(process.env.BRIGHTDATA_API_TOKEN, [
    process.env.BRIGHTDATA_API_TOKENS,
    process.env.API_TOKEN,
  ])[0];
}

export function isBusinessSearchConfigured() {
  return {
    search: hasTavilyKey() || isBrightDataConfigured(),
    pages: Boolean(getBrightDataApiToken()),
  };
}

/** Production wiring: real search providers, Bright Data Pages API, cache and CRM. */
export function createBusinessSearchDeps(): BusinessSearchDeps {
  return {
    tavilySearch: hasTavilyKey()
      ? async (query, signal) => {
          const res = await tavilySearch(query, {
            includeDomains: ["facebook.com"],
            maxResults: 20,
            signal,
          });
          return (res.items || []).map((item: any) => ({
            url: String(item.url || ""),
            title: String(item.title || ""),
            content: String(item.content || ""),
          }));
        }
      : undefined,
    brightDataSearch: isBrightDataConfigured()
      ? async (query, signal) => brightDataSearch(query, { signal })
      : undefined,
    brightDataToken: getBrightDataApiToken(),
    areaSource: isMapDataEnabled()
      ? createOvertureAreaSource({ getRunner: getDuckDbRunner, fetchImpl: safeWebsiteFetch, cache: enrichmentAreaCache })
      : undefined,
    websiteFetch: safeWebsiteFetch,
    pageCache: enrichmentPageCache,
    existingKeys: readExistingIdentityKeys(),
    persist: (leads) => {
      const results = upsertLeadsWithIdentity(leads);
      return {
        created: results.filter((result) => result.disposition === "created").length,
        updated: results.filter((result) => result.disposition === "updated").length,
        duplicates: results.filter((result) => result.disposition === "duplicate").length,
      };
    },
  };
}
