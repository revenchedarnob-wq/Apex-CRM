import type { BusinessDetails } from "../../src/types.js";
import { singularize, type BusinessSearchSpec } from "./brief.js";

/**
 * The AI half of the business search, the same idea as the LinkedIn search: the AI reads
 * the brief in the user's own words, then judges each business against the parts the
 * rules cannot check. Rules stay first: the AI only sees businesses that already passed
 * them, in small batches, so a search costs a few AI calls at most.
 */

/** One structured AI call. Wraps openAIStructured() in the app; a stub in tests. */
export type AiCall = <T>(
  prompt: string,
  schema: Record<string, unknown>,
  system: string,
  options: { maxTokens: number; stage: string; signal?: AbortSignal },
) => Promise<T>;

export type AiVerdict = { verdict: "match" | "maybe" | "no"; reason: string };

const BATCH_SIZE = 10;
const ABOUT_CHARS = 600;

const BRIEF_SYSTEM = `You turn a request for business leads into search settings.
Return:
- trade: the kind of business as a short singular noun phrase ("bakery", "hair salon", "clothing brand"). Never include adjectives about quality, size, price or ownership.
- synonyms: up to 4 other names people and Facebook use for that trade ("cake shop", "patisserie" for bakery; "apparel brand", "fashion brand" for clothing brand). [] if none.
- place: the town, city, region or country exactly as written in the request ("Manchester, UK", "usa"), or "" if none.
- quantity: how many businesses the request asks for ("find 10 ..." is 10), or 0 if it does not say.
- localOnly: true only if the request asks for independent, local, small or family-run businesses.
- requirements: every other condition in the request, each as a short plain sentence ("Makes wedding cakes", "Looks high-end", "Has no online ordering"). Leave out the trade, the place, the quantity, follower counts, and independent, local, small or family-run. [] if none.
Never invent anything the request does not state.`;

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    trade: { type: "string" },
    synonyms: { type: "array", items: { type: "string" } },
    place: { type: "string" },
    quantity: { type: "integer" },
    localOnly: { type: "boolean" },
    requirements: { type: "array", items: { type: "string" } },
  },
  required: ["trade", "synonyms", "place", "quantity", "localOnly", "requirements"],
};

const JUDGE_SYSTEM = `You check businesses against a client's requirements for sales leads.
For each business, decide from the facts given only:
- "match": the facts clearly show it meets every requirement.
- "maybe": the facts do not say either way for at least one requirement.
- "no": the facts clearly show it fails a requirement.
Missing information is "maybe", never "no". Give one short reason in plain English that names the fact you used.`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["match", "maybe", "no"] },
          reason: { type: "string" },
        },
        required: ["id", "verdict", "reason"],
      },
    },
  },
  required: ["results"],
};

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Reads the brief with the AI and merges it into the rules result. The rules keep what
 * they are reliable at (follower counts, the place when the AI names one not in the
 * brief); the AI fixes the trade ("high-end bakeries" is a bakery) and adds requirements.
 * Returns the rules spec unchanged when the AI answer is unusable.
 */
export async function readBriefWithAi(
  rules: BusinessSearchSpec,
  ai: AiCall,
  signal?: AbortSignal,
): Promise<BusinessSearchSpec> {
  const answer = await ai<Record<string, unknown>>(
    `Request: ${rules.brief}`,
    BRIEF_SCHEMA,
    BRIEF_SYSTEM,
    { maxTokens: 500, stage: "business_brief", signal },
  );
  const briefWords = new Set(words(rules.brief).map(singularize));
  const strings = (value: unknown, max: number, maxLength: number) =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string" && item.trim().length > 1)
          .map((item) => item.trim().slice(0, maxLength))
          .slice(0, max)
      : [];

  const trade = typeof answer?.trade === "string" ? answer.trade.trim() : "";
  const tradeTerms = words(trade).map(singularize);
  // A trade the brief never mentions is a guess; keep the rules result.
  const tradeInBrief = tradeTerms.length > 0 && tradeTerms.some((word) => briefWords.has(word));
  const categoryTerms = tradeInBrief ? Array.from(new Set(tradeTerms)) : rules.categoryTerms;

  const place = typeof answer?.place === "string" ? answer.place.trim() : "";
  const placeWords = words(place.split(",")[0] || "");
  const placeInBrief = placeWords.length > 0 && placeWords.every((word) => briefWords.has(singularize(word)));

  const placeText = new Set(words(placeInBrief ? place : rules.place));
  const synonyms = strings(answer?.synonyms, 4, 40).filter(
    (synonym) => !words(synonym).some((word) => placeText.has(word)) && words(synonym).join(" ") !== categoryTerms.join(" "),
  );

  // The count must be a number the brief actually contains.
  const quantity = Number(answer?.quantity);
  const aiCount =
    Number.isInteger(quantity) && quantity >= 1 && quantity <= 100 && new RegExp(`\\b${quantity}\\b`).test(rules.brief)
      ? quantity
      : undefined;
  const requestedCount = rules.requestedCount ?? aiCount;

  return {
    ...rules,
    categoryTerms,
    place: placeInBrief ? place : rules.place,
    synonyms,
    requirements: strings(answer?.requirements, 8, 200),
    localOnly: Boolean(rules.localOnly || answer?.localOnly === true),
    ...(requestedCount ? { requestedCount } : {}),
  };
}

/**
 * What the AI checks for a business. The trade and the place are always included, so
 * the AI can settle businesses the rules marked for review; the brief's own-words
 * requirements follow.
 */
export function judgeChecks(spec: BusinessSearchSpec): string[] {
  const trade = spec.categoryTerms.join(" ");
  return [
    trade && `Is a ${trade}, or the same kind of business under another name`,
    spec.place && `Is based in ${spec.place}`,
    ...(spec.requirements || []),
  ].filter((item): item is string => Boolean(item));
}

/** The facts the AI judges from. Only what the Page or map listing says. */
function describeBusiness(id: string, business: BusinessDetails, onFacebook: boolean): string {
  const facts = [
    `id: ${id}`,
    `name: ${business.name}`,
    business.category && `category: ${business.category}`,
    business.address ? `address: ${business.address}` : business.city && `city: ${business.city}`,
    typeof business.followers === "number" && `Facebook followers: ${business.followers}`,
    typeof business.rating === "number" && `rating: ${business.rating}${business.ratingCount ? ` from ${business.ratingCount} reviews` : ""}`,
    `has website: ${business.websites?.length ? business.websites[0] : "no"}`,
    `has phone: ${business.phones?.length ? "yes" : "no"}`,
    `has email: ${business.emails?.length ? "yes" : "no"}`,
    `on Facebook: ${onFacebook ? "yes" : "no Page found"}`,
    business.about && `about: ${business.about.replace(/\s+/g, " ").slice(0, ABOUT_CHARS)}`,
  ].filter(Boolean);
  return facts.join("\n");
}

/**
 * Judges businesses against judgeChecks(), 10 per AI call. Returns a verdict
 * per id; ids missing from the answer, or from a batch whose call failed, are left out
 * so the rules result stands for them.
 */
export async function judgeBusinesses(
  spec: BusinessSearchSpec,
  items: Array<{ id: string; business: BusinessDetails; onFacebook: boolean }>,
  ai: AiCall,
  options: { signal?: AbortSignal; onError?: (error: unknown) => void } = {},
): Promise<Map<string, AiVerdict>> {
  const verdicts = new Map<string, AiVerdict>();
  const requirements = judgeChecks(spec);
  if (requirements.length === 0 || items.length === 0) return verdicts;
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    if (options.signal?.aborted) break;
    const batch = items.slice(start, start + BATCH_SIZE);
    const prompt = [
      `Client request: ${spec.brief}`,
      `Requirements to check:\n${requirements.map((item) => `- ${item}`).join("\n")}`,
      `Businesses:\n\n${batch.map((item) => describeBusiness(item.id, item.business, item.onFacebook)).join("\n\n")}`,
    ].join("\n\n");
    try {
      const answer = await ai<{ results?: unknown }>(prompt, JUDGE_SCHEMA, JUDGE_SYSTEM, {
        maxTokens: 150 + batch.length * 90,
        stage: "business_judge",
        signal: options.signal,
      });
      const ids = new Set(batch.map((item) => item.id));
      for (const row of Array.isArray(answer?.results) ? answer.results : []) {
        if (!row || typeof row !== "object") continue;
        const { id, verdict, reason } = row as Record<string, unknown>;
        if (typeof id !== "string" || !ids.has(id)) continue;
        if (verdict !== "match" && verdict !== "maybe" && verdict !== "no") continue;
        verdicts.set(id, { verdict, reason: typeof reason === "string" ? reason.trim().slice(0, 240) : "" });
      }
    } catch (error) {
      if ((error as Error)?.name === "AbortError") break;
      options.onError?.(error);
    }
  }
  return verdicts;
}
