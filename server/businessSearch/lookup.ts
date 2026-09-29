import { canonicalFacebookPage } from "../../src/utils/leadDedupe.js";
import type { BusinessSearchSpec } from "./brief.js";
import type { SearchHit } from "./discover.js";
import { nameSimilarity, postcodeDistrict, splitPlaceAndCountry, tradePhrases, type AreaPlace } from "./places.js";

/** Business name from a Facebook search title ("Name | City | Facebook"). */
function titleName(title: string): string {
  const segments = String(title || "").split(/\s+\|\s+/);
  return (segments.length >= 2 ? segments[0] : title)
    .replace(/\s*[|\-\u2013]\s*(?:Facebook|Home|About|Posts|Photos|Reviews)\s*$/i, "")
    .trim();
}

/** One search that finds a known business's Facebook Page by its name. */
export function buildNameLookupQuery(place: AreaPlace, fallbackPlace = ""): string {
  const town = place.city || splitPlaceAndCountry(fallbackPlace).name;
  const name = place.name.replace(/"/g, "").trim();
  return `site:facebook.com "${name}"${town ? ` ${town}` : ""}`;
}

export type LookupMatch = { key: string; url: string; pageId?: string; username?: string; title: string; snippet: string; similarity: number };

/**
 * Picks the search hit that is this business's own Page: a Facebook Page link whose
 * title names the business. Posts on other Pages that mention it are ignored because
 * canonicalFacebookPage() maps them to the other Page, whose name will not match.
 */
export function pickLookupHit(place: AreaPlace, hits: SearchHit[], minSimilarity = 0.6): LookupMatch | null {
  let best: LookupMatch | null = null;
  for (const hit of hits) {
    const page = canonicalFacebookPage(hit.url);
    if (!page) continue;
    const title = String(hit.title || "");
    const fromTitle = nameSimilarity(place.name, titleName(title));
    const fromHandle = page.username ? nameSimilarity(place.name, page.username) : 0;
    const similarity = Math.max(fromTitle, fromHandle);
    if (similarity < minSimilarity) continue;
    if (!best || similarity > best.similarity) {
      best = { ...page, title, snippet: String(hit.content || "").slice(0, 1000), similarity };
    }
  }
  return best;
}

/**
 * Smaller areas inside the searched place, taken from the map listings themselves:
 * UK postcode districts first (M14, M20), then town or neighbourhood names. Busiest
 * areas come first, so a search that stops early has covered the most businesses.
 */
export function areaNamesFromPlaces(places: AreaPlace[], spec: BusinessSearchSpec, max = 12): string[] {
  const placeName = splitPlaceAndCountry(spec.place).name.toLowerCase();
  const counts = new Map<string, number>();
  for (const place of places) {
    const district = postcodeDistrict(place.postcode);
    const name = district || (place.city && place.city.toLowerCase() !== placeName ? place.city : "");
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name]) => name);
}

/** Area-by-area Facebook searches: each area with the main trade phrase and one synonym. */
export function buildAreaQueries(spec: BusinessSearchSpec, areas: string[], max = 24): string[] {
  const phrases = tradePhrases(spec).slice(0, 2);
  const town = splitPlaceAndCountry(spec.place).name;
  const queries: string[] = [];
  for (const area of areas) {
    for (const phrase of phrases) {
      const inTown = town && !area.toLowerCase().includes(town.toLowerCase()) ? ` ${town}` : "";
      queries.push(`site:facebook.com ${phrase} ${area}${inTown}`);
    }
  }
  return Array.from(new Set(queries)).slice(0, max);
}
