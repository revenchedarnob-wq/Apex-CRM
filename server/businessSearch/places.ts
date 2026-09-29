import { canonicalFacebookPage, phoneKey, websiteDomainKey, type FacebookPageRef } from "../../src/utils/leadDedupe.js";
import { singularize, type BusinessSearchSpec } from "./brief.js";

/**
 * One business from a map or register (Overture, a government list), before we know
 * its Facebook Page. Every field except id and name is optional in the source data.
 */
export type AreaPlace = {
  id: string;
  name: string;
  /** Category words from the source, lower case ("bakery", "cake shop"). */
  categories: string[];
  address?: string;
  city?: string;
  postcode?: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country?: string;
  phones: string[];
  websites: string[];
  emails: string[];
  /** Canonical Facebook Pages the source links to this place. */
  facebookPages: FacebookPageRef[];
  /** 0-1 when the source gives one. */
  confidence?: number;
  /** Chain or brand name ("Greggs") when the source marks the place as part of one. */
  brand?: string;
  /** "overture", or another source name. */
  source: string;
};

/** A loaded business list for one place and trade. */
export type AreaLoad = {
  places: AreaPlace[];
  /** Human name of the area actually used ("Manchester, GB"). */
  areaName: string;
  country?: string;
  /** Source version, for example an Overture release. */
  release?: string;
  fromCache: boolean;
};

/** Anything that can list the businesses of one trade in one area. */
export type AreaSource = {
  load(
    spec: BusinessSearchSpec,
    options: { signal?: AbortSignal; onProgress?: (message: string) => void },
  ): Promise<AreaLoad | null>;
};

// Common ways the same trade is named, in briefs, on maps and on Facebook.
const TRADE_SYNONYMS: Record<string, string[]> = {
  bakery: ["bakery", "cake shop", "cupcake shop", "custom cake", "patisserie", "pastry shop", "bakehouse"],
  cafe: ["cafe", "coffee shop", "tea room"],
  restaurant: ["restaurant", "eatery", "bistro"],
  barber: ["barber", "barbershop", "barber shop"],
  salon: ["salon", "hair salon", "beauty salon", "hairdresser"],
  hairdresser: ["hairdresser", "hair salon", "salon"],
  plumber: ["plumber", "plumbing"],
  electrician: ["electrician", "electrical contractor"],
  gym: ["gym", "fitness centre", "fitness center", "fitness studio"],
  florist: ["florist", "flower shop"],
  dentist: ["dentist", "dental clinic", "dental practice"],
  mechanic: ["mechanic", "auto repair", "car repair", "garage"],
  takeaway: ["takeaway", "take away", "fast food"],
  pub: ["pub", "bar", "tavern"],
  builder: ["builder", "building contractor", "construction"],
  cleaner: ["cleaner", "cleaning service"],
  photographer: ["photographer", "photography"],
  "nail salon": ["nail salon", "nail bar", "nails"],
};

const normalizeWords = (text: string): string[] =>
  String(text || "")
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s&'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singularize);

/** The category phrase from a spec ("wedding cake bakery" stays one phrase). */
export function categoryPhrase(spec: BusinessSearchSpec): string {
  return spec.categoryTerms.join(" ").trim();
}

/** Phrases that name the same trade, the brief's own phrase first. */
export function tradePhrases(spec: BusinessSearchSpec): string[] {
  const phrase = categoryPhrase(spec);
  if (!phrase) return [];
  const key = normalizeWords(phrase).join(" ");
  const synonyms = TRADE_SYNONYMS[key] || [];
  return Array.from(new Set([phrase, ...synonyms]));
}

/** True when a place's categories or name contain every word of any trade phrase. */
export function placeMatchesTrade(place: Pick<AreaPlace, "name" | "categories">, spec: BusinessSearchSpec): boolean {
  const available = new Set(normalizeWords([...place.categories, place.name].join(" ")));
  return tradePhrases(spec).some((phrase) => normalizeWords(phrase).every((word) => available.has(word)));
}

const COUNTRY_ALIASES: Record<string, string> = {
  uk: "GB", "u.k.": "GB", "united kingdom": "GB", "great britain": "GB", britain: "GB", england: "GB",
  scotland: "GB", wales: "GB", "northern ireland": "GB", gb: "GB",
  us: "US", usa: "US", "u.s.": "US", "u.s.a.": "US", "united states": "US", america: "US",
  ireland: "IE", canada: "CA", australia: "AU", "new zealand": "NZ", india: "IN", pakistan: "PK",
  bangladesh: "BD", germany: "DE", france: "FR", spain: "ES", italy: "IT", netherlands: "NL",
  turkey: "TR", "t\u00fcrkiye": "TR", uae: "AE", "united arab emirates": "AE", "south africa": "ZA",
  nigeria: "NG", kenya: "KE", singapore: "SG", malaysia: "MY", philippines: "PH",
};

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

/** Splits "Manchester, UK" into the place and an ISO country code when one is named. */
export function splitPlaceAndCountry(place: string): { name: string; country?: string } {
  const parts = String(place || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { name: "" };
  // A whole country ("usa", "UK") has no town part.
  const whole = COUNTRY_ALIASES[parts.join(", ").toLowerCase()];
  if (whole) return { name: "", country: whole };
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const alias = COUNTRY_ALIASES[last.toLowerCase()];
    if (alias) return { name: parts.slice(0, -1).join(", "), country: alias };
    if (/^[A-Z]{2}$/.test(last) && US_STATES.has(last)) return { name: parts.slice(0, -1).join(", "), country: "US" };
  }
  return { name: parts.join(", ") };
}

const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const US_ZIP_WITH_STATE = /\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/;

/** Upper-case postcode without spaces, when the text contains one we recognize. */
export function extractPostcode(text?: string): string {
  if (!text) return "";
  const uk = text.match(UK_POSTCODE);
  if (uk) return `${uk[1]}${uk[2]}`.toUpperCase();
  const us = text.match(US_ZIP_WITH_STATE);
  if (us && US_STATES.has(us[1])) return us[2];
  return "";
}

/** The outward part of a UK postcode ("M14 5ED" -> "M14"), used to split a city into areas. */
export function postcodeDistrict(postcode?: string): string {
  const match = String(postcode || "").toUpperCase().replace(/\s+/g, "").match(/^([A-Z]{1,2}\d[A-Z\d]?)\d[A-Z]{2}$/);
  return match ? match[1] : "";
}

/**
 * The country an address plainly belongs to, or '' when it does not say. Used to drop
 * "Manchester, NH" when the search is for Manchester in the UK.
 */
export function addressCountry(address?: string): string {
  if (!address) return "";
  const text = address.trim();
  const tail = text.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean).pop() || "";
  if (COUNTRY_ALIASES[tail]) return COUNTRY_ALIASES[tail];
  const us = text.match(US_ZIP_WITH_STATE);
  if (us && US_STATES.has(us[1])) return "US";
  if (UK_POSTCODE.test(text)) return "GB";
  return "";
}

const NAME_NOISE = new Set([
  "the", "ltd", "limited", "llc", "inc", "co", "company", "and", "&", "of", "uk", "official", "page",
]);

const nameTokens = (name: string): string[] =>
  String(name || "")
    .toLowerCase()
    .replace(/['\u2019]s\b/g, "s")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token && !NAME_NOISE.has(token));

/**
 * 0-1 similarity of two business names. Uses the share of the shorter name's words
 * found in the longer one, so "Lottie's Bakehouse" matches "Lotties Bakehouse Manchester".
 */
export function nameSimilarity(a: string, b: string): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length) return 0;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  const longerSet = new Set(longer);
  const shared = shorter.filter((token) => longerSet.has(token)).length;
  if (shared === 0) {
    // Names written without spaces: "Long Boi's Bakehouse" vs "longboisbakehouse".
    const joinedShort = shorter.join("");
    const joinedLong = longer.join("");
    return joinedShort.length >= 5 && joinedLong.includes(joinedShort) ? 0.8 : 0;
  }
  return shared / shorter.length;
}

/** Canonical Facebook Pages among a list of social or website links. */
export function facebookPagesFromLinks(links: unknown[]): FacebookPageRef[] {
  const seen = new Map<string, FacebookPageRef>();
  for (const link of links) {
    const page = typeof link === "string" ? canonicalFacebookPage(link) : null;
    if (page && !seen.has(page.key)) seen.set(page.key, page);
  }
  return Array.from(seen.values());
}

export type MatchCheck = {
  /** strong: phone, website or postcode agree. weak: name only. conflict: details disagree. */
  level: "strong" | "weak" | "conflict";
  reasons: string[];
};

const phoneTail = (raw: string): string => {
  const key = phoneKey(raw).replace(/^phone:/, "");
  return key.length >= 9 ? key.slice(-9) : "";
};

/**
 * Checks that a Facebook Page really belongs to a map listing. Phone and website are
 * the strongest evidence; a matching postcode with a similar name is also enough.
 */
export function checkPlaceMatch(
  place: AreaPlace,
  page: { name: string; phones?: string[]; websites?: string[]; address?: string },
): MatchCheck {
  const reasons: string[] = [];
  const placePhones = new Set(place.phones.map(phoneTail).filter(Boolean));
  const pagePhones = (page.phones || []).map(phoneTail).filter(Boolean);
  const phoneMatch = pagePhones.some((tail) => placePhones.has(tail));
  if (phoneMatch) reasons.push("phone matches the map listing");

  const placeSites = new Set(place.websites.map(websiteDomainKey).filter(Boolean));
  const pageSites = (page.websites || []).map(websiteDomainKey).filter(Boolean);
  const websiteMatch = pageSites.some((site) => placeSites.has(site));
  if (websiteMatch) reasons.push("website matches the map listing");

  const pagePostcode = extractPostcode(page.address);
  const placePostcode = place.postcode ? place.postcode.toUpperCase().replace(/\s+/g, "") : extractPostcode(place.address);
  const postcodeMatch = Boolean(pagePostcode && placePostcode && pagePostcode === placePostcode);
  const similarity = nameSimilarity(place.name, page.name);
  if (postcodeMatch && similarity >= 0.5) reasons.push("postcode and name match the map listing");

  if (phoneMatch || websiteMatch || (postcodeMatch && similarity >= 0.5)) return { level: "strong", reasons };

  const phoneConflict = pagePhones.length > 0 && placePhones.size > 0;
  const siteConflict = pageSites.length > 0 && placeSites.size > 0;
  const postcodeConflict = Boolean(pagePostcode && placePostcode && pagePostcode !== placePostcode);
  if ((phoneConflict && siteConflict) || (postcodeConflict && (phoneConflict || siteConflict)) || similarity < 0.5) {
    return { level: "conflict", reasons: [`details differ from the map listing for ${place.name}`] };
  }
  return { level: "weak", reasons: [`name matches the map listing for ${place.name}`] };
}
