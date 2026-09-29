/**
 * Turns a plain-language business brief ("bakeries in Manchester with over 1,000
 * followers") into a small search spec. Deterministic: no LLM, no network.
 */

export type BusinessSearchSpec = {
  /** The brief as typed. */
  brief: string;
  /** Category words to search for and to match against a Page's category. */
  categoryTerms: string[];
  /** Place name, as typed ("Manchester", "Austin, TX"), or '' for anywhere. */
  place: string;
  /** Minimum Facebook followers, or 0 for no minimum. */
  minFollowers: number;
  /** Extra words the Page should mention ("weddings", "vegan"). Used for ranking, not filtering. */
  extras: string[];
  /**
   * Conditions in the user's own words that the rules cannot check ("Looks high-end"),
   * read by the AI (aiJudge.ts). Empty or missing when there are none or no AI is set up.
   */
  requirements?: string[];
  /** Other names for the trade from the AI ("apparel brand" for "clothing brand"). */
  synonyms?: string[];
  /** How many businesses the brief asks for ("find 10 bakeries"), when it says. */
  requestedCount?: number;
  /** True when the brief asks for independent or local businesses, so chains are left out. */
  localOnly?: boolean;
};

const LOCAL_ONLY = /\b(?:independent|independently|local|small|family[- ]?(?:run|owned)?)\b/i;

// "find 10 bakeries", "get me 25 salons", "10 plumbers in Leeds". Not "10k followers".
const COUNT_PATTERN =
  /^\s*(?:(?:please\s+)?(?:find|get|show|list|give|search|search\s+for|look\s+for)\s+)?(?:me\s+)?(?:about\s+|around\s+|up\s+to\s+|top\s+)?(\d{1,3})\s+(?!k\b|thousand\b|\+|followers|likes|fans)/i;

const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'find', 'me', 'get', 'show', 'list', 'search', 'for', 'some', 'any', 'all',
  'local', 'small', 'business', 'businesses', 'company', 'companies', 'shop', 'shops', 'store',
  'stores', 'page', 'pages', 'facebook', 'fb', 'on', 'that', 'which', 'who', 'are', 'is',
  'with', 'and', 'or', 'of', 'to', 'please', 'owners', 'owner',
  // Describe the kind of business, not its trade; rounds.ts uses them to leave chains out.
  'independent', 'independently', 'family', 'family-run', 'family-owned', 'run', 'owned',
]);

// Words that start the "extras" part of a brief: "bakeries in Leeds that do weddings".
const EXTRAS_MARKERS = /\b(?:that|which|who)\s+(?:do|does|offer|offers|sell|sells|make|makes|specialize|specializes|specialise|specialises|provide|provides)\s+(?:in\s+)?/i;

const FOLLOWERS_PATTERN =
  /\b(?:with\s+)?(?:over|more\s+than|at\s+least|above|min(?:imum)?(?:\s+of)?|>=?|\+)?\s*([\d][\d,.]*)\s*(k|thousand)?\s*\+?\s*(?:or\s+more\s+)?(?:followers|likes|fans)\b/i;

const PLACE_PATTERN = /\b(?:in|near|around|based\s+in|located\s+in)\s+([^,.;]+(?:,\s*[A-Za-z][A-Za-z .]{1,30})?)/i;

function parseFollowerCount(raw: string, unit?: string): number {
  const value = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(value)) return 0;
  return Math.round(unit ? value * 1000 : value);
}

/** Very small English singularizer for category words ("bakeries" -> "bakery"). */
export function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length <= 3 || lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is')) return lower;
  if (lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes)$/.test(lower)) return lower.slice(0, -2);
  if (lower.endsWith('s')) return lower.slice(0, -1);
  return lower;
}

export function parseBusinessBrief(brief: string): BusinessSearchSpec {
  let rest = ` ${String(brief || '').replace(/\s+/g, ' ').trim()} `;

  let requestedCount: number | undefined;
  const count = rest.match(COUNT_PATTERN);
  if (count) {
    const value = Number(count[1]);
    if (value >= 1 && value <= 100) requestedCount = value;
    rest = ` ${rest.slice(count[0].length)}`;
  }

  let minFollowers = 0;
  const followers = rest.match(FOLLOWERS_PATTERN);
  if (followers) {
    minFollowers = parseFollowerCount(followers[1], followers[2]);
    rest = rest.replace(followers[0], ' ');
  }

  let extras: string[] = [];
  const extrasMatch = rest.match(EXTRAS_MARKERS);
  if (extrasMatch && extrasMatch.index !== undefined) {
    const tail = rest.slice(extrasMatch.index + extrasMatch[0].length);
    extras = tail
      .split(/\s*(?:,|\band\b|\bor\b)\s*/i)
      .map((part) => part.replace(/[^\p{L}\p{N}\s&'-]/gu, '').trim().toLowerCase())
      .filter((part) => part.length > 1);
    rest = rest.slice(0, extrasMatch.index);
  }

  let place = '';
  const placeMatch = rest.match(PLACE_PATTERN);
  if (placeMatch) {
    place = placeMatch[1].replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');
    rest = rest.replace(placeMatch[0], ' ');
  }

  const categoryTerms = Array.from(
    new Set(
      rest
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s&'-]/gu, ' ')
        .split(/\s+/)
        .filter((word) => word && !FILLER_WORDS.has(word) && !/^\d+$/.test(word))
        .map(singularize),
    ),
  );

  return {
    brief: String(brief || '').trim(),
    categoryTerms,
    place,
    minFollowers,
    extras,
    ...(requestedCount ? { requestedCount } : {}),
    localOnly: LOCAL_ONLY.test(String(brief || '')),
  };
}
