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
import type { PageCache } from "./facebookPages.js";
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
