import type { BusinessDetails } from "../../src/types.js";
import { canonicalFacebookPage } from "../../src/utils/leadDedupe.js";

/**
 * Bright Data Web Scraper API, "Facebook Pages and Profiles - collect by URL".
 * Returns structured Page records (category, address, phones, emails, websites,
 * followers, rating). Docs: https://docs.brightdata.com/api-reference/scrapers/social-media-apis/facebook-pages-and-profiles-collect-by-url
 */
export const FACEBOOK_PAGES_DATASET_ID = "gd_mf124a0511bauquyow";
const API_BASE = "https://api.brightdata.com/datasets/v3";
export const PAGES_BATCH_SIZE = 20;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type PageReadResult = {
  /** Canonical Page key from canonicalFacebookPage(). */
  key: string;
  business?: BusinessDetails;
  error?: string;
};

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

/** Accepts a string, an array of strings, or an array of objects with a value-like field. */
const toStringList = (value: unknown): string[] => {
  const out: string[] = [];
  const push = (item: unknown) => {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const nested = firstString(record.value, record.url, record.link, record.number, record.email, record.text);
      if (nested) out.push(nested);
    }
  };
  if (Array.isArray(value)) value.forEach(push);
  else if (typeof value === "string") value.split(/\s*[;|]\s*/).forEach(push);
  else push(value);
  return Array.from(new Set(out));
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/([\d.]+)\s*([kKmM])?/);
    if (!match) return undefined;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return undefined;
    const unit = match[2]?.toLowerCase();
    return Math.round(unit === "k" ? base * 1e3 : unit === "m" ? base * 1e6 : base);
  }
  return undefined;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Maps one Bright Data Page record to BusinessDetails. Field names follow Bright Data's
 * documented output; alternatives are accepted because record shapes vary by Page type.
 */
export function mapPageRecord(record: Record<string, any>, fetchedAt = new Date().toISOString()): BusinessDetails | null {
  if (!record || typeof record !== "object" || record.error || record.error_code) return null;
  const info = (record.contact_and_basic_info && typeof record.contact_and_basic_info === "object")
    ? record.contact_and_basic_info
    : {};
  // Live records (2026-09) nest contact details one level deeper, in contact_info.
  const contact = (info.contact_info && typeof info.contact_info === "object") ? info.contact_info : {};
  const basic = (info.basic_info && typeof info.basic_info === "object") ? info.basic_info : {};
  const name = firstString(record.page_name, record.name, record.title);
  if (!name) return null;

  const page = canonicalFacebookPage(firstString(record.url, record.page_url, record.input?.url));
  const pageId = firstString(record.page_id, typeof record.id === "number" ? String(record.id) : record.id);
  const ratingValue = typeof record.rating === "object" && record.rating
    ? toNumber(record.rating.value ?? record.rating.rating ?? record.rating.average)
    : toNumber(record.rating);
  const ratingCount = typeof record.rating === "object" && record.rating
    ? toNumber(record.rating.count ?? record.rating.reviews ?? record.rating.total)
    : toNumber(record.reviews_count ?? record.rating_count ?? basic.rating?.count);
  const categories = toStringList(record.categories ?? info.categories);
  const phones = toStringList(record.phones ?? record.phone ?? info.phones ?? info.phone ?? contact.phones);
  const emails = toStringList(record.emails ?? record.email ?? info.emails ?? info.email ?? contact.emails)
    .map((email) => email.toLowerCase())
    .filter((email) => EMAIL_PATTERN.test(email));
  const websites = toStringList(record.websites ?? record.website ?? info.websites ?? info.website ?? contact.websites);
  const address = firstString(
    typeof record.address === "object" && record.address ? record.address.formatted ?? record.address.full : record.address,
    info.address,
    contact.address?.formatted,
  );

  // Some live records give a bare ".../profile.php" URL; rebuild it from the id or handle.
  const username = firstString(record.username)?.replace(/^@/, "");
  const fallbackPage = page
    || (pageId && /^\d{5,25}$/.test(pageId) ? canonicalFacebookPage(`https://www.facebook.com/profile.php?id=${pageId}`) : null)
    || (username ? canonicalFacebookPage(`https://www.facebook.com/${username}`) : null);

  const business: BusinessDetails = {
    name,
    pageUrl: fallbackPage?.url || firstString(record.url),
    pageId: pageId && /^\d{5,25}$/.test(pageId) ? pageId : page?.pageId,
    username: username || page?.username,
    category: firstString(record.primary_category, record.category, categories[0]),
    categories: categories.length ? categories : undefined,
    about: firstString(record.summary_text, record.intro, record.about, record.description, record.details_about?.about_text),
    address,
    city: firstString(record.city, typeof record.address === "object" ? record.address?.city : undefined, record.location),
    phones: phones.length ? phones : undefined,
    emails: emails.length ? emails : undefined,
    websites: websites.length ? websites : undefined,
    followers: toNumber(record.followers ?? record.followers_count ?? record.page_followers),
    rating: ratingValue !== undefined && ratingValue >= 0 && ratingValue <= 5 ? ratingValue : undefined,
    ratingCount,
    verified: typeof record.is_verified === "boolean" ? record.is_verified : undefined,
    fetchedAt,
    dataQuality: "full",
  };
  for (const key of Object.keys(business) as Array<keyof BusinessDetails>) {
    if (business[key] === undefined) delete business[key];
  }
  return business;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

async function readJsonArray(response: Response): Promise<any[]> {
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // NDJSON fallback
    return trimmed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

/**
 * Reads up to PAGES_BATCH_SIZE Pages in one synchronous call. When Bright Data needs
 * longer than its one-minute sync window it answers 202 with a snapshot id; we then
 * poll progress and download the snapshot, up to `maxWaitMs`.
 */
export async function scrapePagesBatch(
  urls: string[],
  options: { token: string; fetchImpl?: FetchLike; signal?: AbortSignal; maxWaitMs?: number; pollMs?: number },
): Promise<any[]> {
  const fetchImpl = options.fetchImpl || (fetch as FetchLike);
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  };
  const response = await fetchImpl(
    `${API_BASE}/scrape?dataset_id=${FACEBOOK_PAGES_DATASET_ID}&format=json&include_errors=true&notify=false`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ input: urls.map((url) => ({ url })) }),
      signal: options.signal,
    },
  );
  if (response.status === 200) return readJsonArray(response);
  if (response.status !== 202) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Bright Data Pages scrape failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }

  const pending = (await response.json().catch(() => ({}))) as { snapshot_id?: string };
  const snapshotId = pending.snapshot_id;
  if (!snapshotId || !/^[A-Za-z0-9_-]{4,100}$/.test(snapshotId)) {
    throw new Error("Bright Data returned 202 without a usable snapshot id");
  }
  const deadline = Date.now() + (options.maxWaitMs ?? 180_000);
  const pollMs = options.pollMs ?? 10_000;
  while (Date.now() < deadline) {
    await sleep(pollMs, options.signal);
    const progress = await fetchImpl(`${API_BASE}/progress/${snapshotId}`, { headers, signal: options.signal });
    const state = (await progress.json().catch(() => ({}))) as { status?: string };
    if (state.status === "failed") throw new Error(`Bright Data snapshot ${snapshotId} failed`);
    if (state.status === "ready") {
      const download = await fetchImpl(`${API_BASE}/snapshot/${snapshotId}?format=json`, { headers, signal: options.signal });
      if (!download.ok) throw new Error(`Bright Data snapshot download failed with HTTP ${download.status}`);
      return readJsonArray(download);
    }
  }
  throw new Error(`Bright Data snapshot ${snapshotId} was not ready in time`);
}

export type PageCache = {
  get: (key: string) => BusinessDetails | null;
  set: (key: string, business: BusinessDetails) => void;
};

/**
 * Reads Pages in batches of 20. Cached Pages cost nothing. A failed batch is retried
 * once; if it fails again its Pages come back with an error so the caller can fall back
 * to search-snippet data instead of losing them.
 */
export async function readFacebookPages(
  pageUrls: Array<{ key: string; url: string }>,
  options: {
    token: string;
    cache?: PageCache;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    maxWaitMs?: number;
    pollMs?: number;
    onProgress?: (message: string) => void;
  },
): Promise<{ results: PageReadResult[]; cached: number; fetched: number; failed: number }> {
  const results = new Map<string, PageReadResult>();
  const toFetch: Array<{ key: string; url: string }> = [];
  let cached = 0;
  for (const page of pageUrls) {
    const hit = options.cache?.get(page.key);
    if (hit) {
      results.set(page.key, { key: page.key, business: hit });
      cached++;
    } else {
      toFetch.push(page);
    }
  }

  let fetched = 0;
  let failed = 0;
  for (let i = 0; i < toFetch.length; i += PAGES_BATCH_SIZE) {
    if (options.signal?.aborted) break;
    const batch = toFetch.slice(i, i + PAGES_BATCH_SIZE);
    let records: any[] | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && records === null; attempt++) {
      try {
        records = await scrapePagesBatch(batch.map((page) => page.url), options);
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        lastError = (error as Error)?.message || String(error);
      }
    }
    if (records === null) {
      failed += batch.length;
      for (const page of batch) results.set(page.key, { key: page.key, error: lastError });
      options.onProgress?.(`Could not read ${batch.length} Page(s): ${lastError}`);
      continue;
    }

    const now = new Date().toISOString();
    const byKey = new Map<string, BusinessDetails>();
    for (const record of records) {
      const business = mapPageRecord(record, now);
      if (!business) continue;
      const ref = canonicalFacebookPage(firstString(record?.input?.url, record?.url, business.pageUrl));
      if (ref) byKey.set(ref.key, business);
      if (business.pageId) byKey.set(`facebook:id:${business.pageId}`, business);
      if (business.username) byKey.set(`facebook:user:${business.username.toLowerCase()}`, business);
    }
    for (const page of batch) {
      const business = byKey.get(page.key);
      if (business) {
        results.set(page.key, { key: page.key, business });
        options.cache?.set(page.key, business);
        fetched++;
      } else {
        results.set(page.key, { key: page.key, error: "No data returned for this Page" });
        failed++;
      }
    }
    options.onProgress?.(`Read ${Math.min(i + PAGES_BATCH_SIZE, toFetch.length)} of ${toFetch.length} Pages from Bright Data.`);
  }

  return {
    results: pageUrls.map((page) => results.get(page.key) || { key: page.key, error: "Not read" }),
    cached,
    fetched,
    failed,
  };
}
