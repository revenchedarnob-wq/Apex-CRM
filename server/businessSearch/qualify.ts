import type { BusinessDetails } from "../../src/types.js";
import { singularize, type BusinessSearchSpec } from "./brief.js";
import { tradePhrases } from "./places.js";

export type CheckResult = "pass" | "fail" | "unsure";

export type Qualification = {
  verdict: "qualified" | "maybe" | "rejected";
  checks: { category: CheckResult; place: CheckResult; contact: CheckResult; followers: CheckResult };
  /** Plain-language reasons shown on the lead. */
  reasons: string[];
  /** 0-10, used to order results. */
  score: number;
};

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singularize);

function containsAllTerms(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const available = new Set(words(haystack));
  return terms.every((term) => words(term).every((word) => available.has(word)));
}

/** The first part of a place ("Austin, TX" -> "austin"), for matching against addresses. */
function placeTokens(place: string): string[] {
  const head = place.split(",")[0] || "";
  return words(head).filter((word) => word.length > 1);
}

/**
 * Rules-only qualification. Every check is based on the Page's structured fields, so
 * the reasons are verifiable by opening the Page. "unsure" never rejects a business;
 * it marks it for review instead.
 */
export function qualifyBusiness(business: BusinessDetails, spec: BusinessSearchSpec): Qualification {
  const reasons: string[] = [];
  const categoryText = [business.category, ...(business.categories || [])].filter(Boolean).join(" ");
  const descriptiveText = [business.name, business.about].filter(Boolean).join(" ");

  let category: CheckResult;
  // Any common name for the trade counts: a "Cake Shop" Page matches a search for bakeries.
  const phrases = tradePhrases(spec);
  const matchesTrade = (text: string) =>
    phrases.length === 0 ? containsAllTerms(text, spec.categoryTerms) : phrases.some((phrase) => containsAllTerms(text, [phrase]));
  if (matchesTrade(categoryText)) {
    category = "pass";
    reasons.push(`Category: ${business.category || spec.categoryTerms.join(" ")}`);
  } else if (matchesTrade(descriptiveText)) {
    category = categoryText ? "unsure" : "pass";
    reasons.push(`Name or intro mentions ${spec.categoryTerms.join(" ")}`);
  } else {
    category = business.dataQuality === "partial" ? "unsure" : "fail";
    if (category === "fail") reasons.push(`Category "${business.category || "unknown"}" does not match ${spec.categoryTerms.join(" ")}`);
  }

  let place: CheckResult = "pass";
  if (spec.place) {
    const tokens = placeTokens(spec.place);
    const locationText = [business.address, business.city].filter(Boolean).join(" ");
    const locationWords = new Set(words(locationText));
    const aboutWords = new Set(words(descriptiveText));
    if (locationText && tokens.every((token) => locationWords.has(token))) {
      place = "pass";
      reasons.push(`Located in ${spec.place}`);
    } else if (locationText) {
      place = "fail";
      reasons.push(`Address is outside ${spec.place}: ${locationText}`);
    } else if (tokens.every((token) => aboutWords.has(token))) {
      place = "unsure";
      reasons.push(`Mentions ${spec.place}, no address listed`);
    } else {
      place = "unsure";
      reasons.push("No address listed");
    }
  }

  const contactCount =
    (business.phones?.length || 0) + (business.emails?.length || 0) + (business.websites?.length || 0);
  const contact: CheckResult = contactCount > 0 ? "pass" : "unsure";
  if (contact === "pass") {
    const parts = [
      business.phones?.length ? "phone" : "",
      business.emails?.length ? "email" : "",
      business.websites?.length ? "website" : "",
    ].filter(Boolean);
    reasons.push(`Contact: ${parts.join(", ")}`);
  } else {
    reasons.push("No phone, email or website on the Page");
  }

  let followers: CheckResult = "pass";
  if (spec.minFollowers > 0) {
    if (typeof business.followers !== "number") {
      followers = "unsure";
      reasons.push("Follower count unknown");
    } else if (business.followers < spec.minFollowers) {
      followers = "fail";
      reasons.push(`${business.followers.toLocaleString("en-US")} followers, below ${spec.minFollowers.toLocaleString("en-US")}`);
    } else {
      reasons.push(`${business.followers.toLocaleString("en-US")} followers`);
    }
  }

  const checks = { category, place, contact, followers };
  const results = Object.values(checks);
  const verdict = results.includes("fail") ? "rejected" : results.includes("unsure") ? "maybe" : "qualified";

  // Score: fit dominates, then reachability, audience and reputation.
  let score = 0;
  score += category === "pass" ? 3 : category === "unsure" ? 1.5 : 0;
  score += place === "pass" ? 2 : place === "unsure" ? 1 : 0;
  score += Math.min(contactCount, 3) * 0.6;
  if (typeof business.followers === "number" && business.followers > 0) {
    score += Math.min(1.5, Math.log10(business.followers) / 3);
  }
  if (typeof business.rating === "number") score += (business.rating / 5) * 0.7;
  const extrasMatched = spec.extras.filter((extra) => containsAllTerms(descriptiveText, [extra]));
  if (extrasMatched.length) {
    score += Math.min(1, extrasMatched.length * 0.5);
    reasons.push(`Mentions ${extrasMatched.join(", ")}`);
  }
  if (business.dataQuality === "partial") score -= 1;

  return {
    verdict,
    checks,
    reasons,
    score: Math.max(0, Math.min(10, Math.round(score * 10) / 10)),
  };
}

const NAME = "([A-Z][a-z'\\-]+(?:\\s+[A-Z][a-z'\\-]+){1,2})";
const OWNER_PATTERNS: Array<{ pattern: RegExp; confidence: number }> = [
  { pattern: new RegExp(`\\b(?:[Oo]wned|[Rr]un|[Ff]ounded|[Mm]anaged)\\s+by\\s+${NAME}`), confidence: 0.85 },
  { pattern: new RegExp(`\\b(?:[Oo]wner|[Ff]ounder|[Cc]o-founder|[Pp]roprietor|[Dd]irector)\\s*[:,-]?\\s+${NAME}`), confidence: 0.8 },
  { pattern: new RegExp(`${NAME}\\s*[,-]?\\s+(?:is\\s+the\\s+)?(?:owner|founder|proprietor)\\b`), confidence: 0.75 },
  { pattern: new RegExp(`\\b(?:I'm|I am|My name is)\\s+${NAME}`), confidence: 0.6 },
];

/** Finds an owner's name in Page text. Returns null rather than guessing. */
export function extractOwnerName(text?: string): { name: string; confidence: number } | null {
  if (!text) return null;
  for (const { pattern, confidence } of OWNER_PATTERNS) {
    const match = text.match(pattern);
    const name = match?.[1]?.trim();
    if (name && !/\b(?:The|Our|We|Team|Shop|Bakery|Ltd|Limited|Inc|LLC)\b/.test(name)) {
      return { name, confidence };
    }
  }
  return null;
}
