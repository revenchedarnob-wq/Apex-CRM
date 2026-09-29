import { canonicalFacebookPage, type FacebookPageRef } from "../../src/utils/leadDedupe.js";
import type { FetchLike } from "./facebookPages.js";

const MAX_HTML_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 8_000;

// Hosts that are never a business's own site, so there is nothing to check.
const SKIP_HOSTS = /(?:^|\.)(?:facebook\.com|fb\.com|instagram\.com|linkedin\.com|tiktok\.com|twitter\.com|x\.com|youtube\.com|google\.[a-z.]+|goo\.gl|linktr\.ee|wa\.me|whatsapp\.com)$/i;

/**
 * Facebook Pages linked from a web page's HTML, most-linked first. Share buttons and
 * plugin links are dropped by canonicalFacebookPage().
 */
export function facebookPagesInHtml(html: string): FacebookPageRef[] {
  const counts = new Map<string, { page: FacebookPageRef; count: number }>();
  const pattern = /https?:\/\/(?:[a-z0-9-]+\.)?(?:facebook\.com|fb\.com)\/[^\s"'<>)\\]+/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = match[0].replace(/&amp;/g, "&");
    const page = canonicalFacebookPage(raw);
    if (!page) continue;
    const entry = counts.get(page.key);
    if (entry) entry.count++;
    else counts.set(page.key, { page, count: 1 });
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.page);
}

/** True for http(s) URLs of a business's own website. */
export function isCheckableWebsite(rawUrl: string): boolean {
  try {
    const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    return /^https?:$/.test(url.protocol) && url.hostname.includes(".") && !SKIP_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Opens a business's home page and returns the Facebook Page it links to, if any.
 * Free: the app fetches the site itself. Never throws; a failed fetch returns null.
 */
export async function findFacebookOnWebsite(
  rawUrl: string,
  options: { fetchImpl: FetchLike; signal?: AbortSignal; timeoutMs?: number },
): Promise<FacebookPageRef | null> {
  if (!isCheckableWebsite(rawUrl) || options.signal?.aborted) return null;
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await options.fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; ApexCRM/1.0)" },
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") || "";
    if (type && !/html|text/i.test(type)) return null;
    const html = (await response.text()).slice(0, MAX_HTML_BYTES);
    return facebookPagesInHtml(html)[0] || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Runs async work over items with a small fixed number in flight. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length && !shouldStop?.()) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return results;
}
