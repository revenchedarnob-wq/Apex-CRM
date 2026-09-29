import type { BusinessSearchSpec } from "./brief.js";
import type { FetchLike } from "./facebookPages.js";
import {
  extractPostcode,
  facebookPagesFromLinks,
  placeMatchesTrade,
  splitPlaceAndCountry,
  tradePhrases,
  type AreaLoad,
  type AreaPlace,
  type AreaSource,
} from "./places.js";

/**
 * Overture Maps Places: a free, open dataset of about 80 million places (CDLA
 * Permissive 2.0, credit "Overture Maps Foundation"). Many business records carry
 * the business's Facebook Page in `socials`, so an area's Pages can be listed
 * without paying for search. Files are GeoParquet on a public S3 bucket; DuckDB
 * reads only the parts of the files inside the area's bounding box.
 * Guide: https://docs.overturemaps.org/guides/places/
 */
const BUCKET_HTTP = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com";
const BUCKET_S3 = "s3://overturemaps-us-west-2";
const MAX_PLACES = 5000;
const MIN_CONFIDENCE = 0.5;

/** Runs one SQL statement and returns plain row objects. */
export type QueryRunner = (sql: string) => Promise<Record<string, unknown>[]>;

export type Bbox = { xmin: number; ymin: number; xmax: number; ymax: number };

export type AreaCache = {
  get(key: string): AreaLoad | null;
  set(key: string, value: AreaLoad): void;
};

const sqlString = (value: string) => `'${String(value).replace(/'/g, "''")}'`;

/** Letters, digits and spaces only, so category words are safe inside LIKE patterns. */
const likeWords = (phrase: string) =>
  phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);

/** Latest release folder, for example "2026-09-23.0", from the public bucket listing. */
export async function latestOvertureRelease(fetchImpl: FetchLike, signal?: AbortSignal): Promise<string | null> {
  const override = process.env.OVERTURE_RELEASE?.trim();
  if (override) return override;
  try {
    const response = await fetchImpl(`${BUCKET_HTTP}/?list-type=2&prefix=release/&delimiter=/`, { signal });
    if (!response.ok) return null;
    const xml = await response.text();
    const releases = Array.from(xml.matchAll(/<Prefix>release\/([^/<]+)\/<\/Prefix>/g)).map((match) => match[1]);
    return releases.filter((release) => /^\d{4}-\d{2}-\d{2}/.test(release)).sort().pop() || null;
  } catch {
    return null;
  }
}

/** Finds the named town or city in Overture's boundaries, with its population when known. */
export function buildDivisionSql(release: string, name: string, country?: string): string {
  const base = `${BUCKET_S3}/release/${release}/theme=divisions`;
  const countryFilter = country ? ` AND country = ${sqlString(country)}` : "";
  const nameFilter = `lower(names.primary) = ${sqlString(name.toLowerCase())}`;
  const subtypes = "('locality','localadmin','county','borough','macrohood','neighborhood','region')";
  return `WITH areas AS (
  SELECT * EXCLUDE (geometry) FROM read_parquet('${base}/type=division_area/*', hive_partitioning=1)
  WHERE ${nameFilter} AND subtype IN ${subtypes}${countryFilter}
), divisions AS (
  SELECT * EXCLUDE (geometry) FROM read_parquet('${base}/type=division/*', hive_partitioning=1)
  WHERE ${nameFilter} AND subtype IN ${subtypes}${countryFilter}
)
SELECT CAST(to_json(a) AS VARCHAR) AS area, CAST(to_json(d) AS VARCHAR) AS division
FROM areas a LEFT JOIN divisions d ON d.id = a.division_id
LIMIT 50`;
}

type DivisionChoice = { name: string; country?: string; bbox: Bbox; population?: number };

const parseJson = (value: unknown): Record<string, any> | null => {
  if (value && typeof value === "object") return value as Record<string, any>;
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const SUBTYPE_RANK: Record<string, number> = {
  locality: 0, localadmin: 1, borough: 2, macrohood: 3, neighborhood: 4, county: 5, region: 6,
};

/**
 * Picks the most likely area for a name: the requested country first, then towns and
 * cities over counties, then the most populous, then the largest.
 */
export function pickDivision(rows: Record<string, unknown>[], country?: string): DivisionChoice | null {
  const choices = rows
    .map((row) => {
      const area = parseJson(row.area);
      const division = parseJson(row.division);
      const bbox = area?.bbox;
      if (!area || !bbox || ![bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax].every((v) => typeof v === "number")) return null;
      const population = typeof division?.population === "number" ? division.population : undefined;
      return {
        name: String(area.names?.primary || ""),
        country: typeof area.country === "string" ? area.country : undefined,
        subtype: String(area.subtype || ""),
        bbox: { xmin: bbox.xmin, ymin: bbox.ymin, xmax: bbox.xmax, ymax: bbox.ymax } as Bbox,
        population,
        size: (bbox.xmax - bbox.xmin) * (bbox.ymax - bbox.ymin),
      };
    })
    .filter((choice): choice is NonNullable<typeof choice> => Boolean(choice));
  if (!choices.length) return null;
  choices.sort((a, b) => {
    if (country) {
      const byCountry = Number(b.country === country) - Number(a.country === country);
      if (byCountry) return byCountry;
    }
    const byType = (SUBTYPE_RANK[a.subtype] ?? 9) - (SUBTYPE_RANK[b.subtype] ?? 9);
    if (byType) return byType;
    const byPopulation = (b.population || 0) - (a.population || 0);
    if (byPopulation) return byPopulation;
    return b.size - a.size;
  });
  const { name, country: chosenCountry, bbox, population } = choices[0];
  return { name, country: chosenCountry, bbox, population };
}

/** Places of the trade inside the box. Filters on the whole record's text, then maps in code. */
export function buildPlacesSql(release: string, bbox: Bbox, phrases: string[]): string {
  const base = `${BUCKET_S3}/release/${release}/theme=places/type=place/*`;
  const n = (value: number) => Number(value).toFixed(6);
  const phraseFilters = phrases
    .map(likeWords)
    .filter((words) => words.length > 0)
    .map((words) => `(${words.map((word) => `lower(raw) LIKE '%${word}%'`).join(" AND ")})`);
  const textFilter = phraseFilters.length ? `WHERE ${phraseFilters.join(" OR ")}` : "";
  return `WITH p AS (
  SELECT * EXCLUDE (geometry) FROM read_parquet('${base}', hive_partitioning=1)
  WHERE bbox.xmin >= ${n(bbox.xmin)} AND bbox.xmax <= ${n(bbox.xmax)}
    AND bbox.ymin >= ${n(bbox.ymin)} AND bbox.ymax <= ${n(bbox.ymax)}
)
SELECT raw AS j FROM (SELECT CAST(to_json(p) AS VARCHAR) AS raw FROM p) ${textFilter}
LIMIT ${MAX_PLACES}`;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : typeof value === "string" && value.trim()
      ? [value.trim()]
      : [];

/** Category words from any of Overture's category fields, old or new schema. */
function overtureCategories(record: Record<string, any>): string[] {
  const out: string[] = [];
  const add = (value: unknown) => strings(value).forEach((item) => out.push(item.replace(/_/g, " ").toLowerCase()));
  add(record.basic_category);
  add(record.categories?.primary);
  add(record.categories?.alternate);
  add(record.taxonomy?.primary);
  add(record.taxonomy?.hierarchy);
  add(record.taxonomy?.alternates);
  return Array.from(new Set(out));
}

/** Maps one Overture place record to an AreaPlace; drops closed and low-confidence places. */
export function mapOverturePlace(raw: unknown): AreaPlace | null {
  const record = parseJson(raw);
  if (!record) return null;
  const name = String(record.names?.primary || "").trim();
  if (!record.id || !name) return null;
  const status = String(record.operating_status || "open").toLowerCase();
  if (status && status !== "open") return null;
  const confidence = typeof record.confidence === "number" ? record.confidence : undefined;
  if (confidence !== undefined && confidence < MIN_CONFIDENCE) return null;

  const address = Array.isArray(record.addresses) ? record.addresses[0] || {} : {};
  const freeform = typeof address.freeform === "string" ? address.freeform : "";
  const city = typeof address.locality === "string" ? address.locality : undefined;
  const postcode = typeof address.postcode === "string" ? address.postcode.toUpperCase().replace(/\s+/g, "") : extractPostcode(freeform) || undefined;
  const country = typeof address.country === "string" ? address.country.toUpperCase() : undefined;
  const fullAddress = [freeform, city, typeof address.postcode === "string" ? address.postcode : ""].filter(Boolean).join(", ");
  const socials = strings(record.socials);

  const place: AreaPlace = {
    id: `overture:${record.id}`,
    name,
    categories: overtureCategories(record),
    address: fullAddress || undefined,
    city,
    postcode: postcode || undefined,
    country,
    phones: strings(record.phones),
    websites: strings(record.websites),
    emails: strings(record.emails).map((email) => email.toLowerCase()),
    facebookPages: facebookPagesFromLinks([...socials, ...strings(record.websites)]),
    confidence,
    brand: typeof record.brand?.names?.primary === "string" ? record.brand.names.primary : undefined,
    source: "overture",
  };
  if (!place.brand) delete place.brand;
  return place;
}

/** Keeps places of the trade that lie in the named place, not just inside its box. */
export function filterAreaPlaces(places: AreaPlace[], spec: BusinessSearchSpec, areaName: string): AreaPlace[] {
  const town = (splitPlaceAndCountry(spec.place).name || areaName).toLowerCase();
  const seen = new Set<string>();
  return places.filter((place) => {
    if (!placeMatchesTrade(place, spec)) return false;
    const text = `${place.city || ""} ${place.address || ""}`.toLowerCase();
    if (town && text.trim() && !text.includes(town)) return false;
    const key = place.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function areaCacheKey(spec: BusinessSearchSpec): string {
  return `overture:${spec.place.trim().toLowerCase()}:${tradePhrases(spec).join("|").toLowerCase()}`;
}

/**
 * Loads DuckDB if it is installed. Returns null otherwise, so the search still runs
 * on web search alone. Loaded by name so the app builds without it.
 */
export async function loadDuckDbQueryRunner(): Promise<QueryRunner | null> {
  const moduleName = "@duckdb/node-api";
  let duckdb: any;
  try {
    duckdb = await import(moduleName);
  } catch {
    return null;
  }
  const instance = await duckdb.DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  // The bucket is public. Empty keys stop DuckDB from sending AWS credentials found in
  // the environment, which the bucket would reject.
  for (const statement of [
    "INSTALL httpfs",
    "LOAD httpfs",
    "SET s3_region='us-west-2'",
    "SET s3_access_key_id=''",
    "SET s3_secret_access_key=''",
    "SET s3_session_token=''",
  ]) {
    await connection.run(statement);
  }
  return async (sql: string) => {
    const reader = await connection.runAndReadAll(sql);
    return (reader.getRowObjectsJson?.() ?? reader.getRowObjects()) as Record<string, unknown>[];
  };
}

/** Overture as an AreaSource: find the place's boundary, then list its businesses of the trade. */
export function createOvertureAreaSource(options: {
  getRunner: () => Promise<QueryRunner | null>;
  fetchImpl: FetchLike;
  cache?: AreaCache;
}): AreaSource {
  return {
    async load(spec, { signal, onProgress }) {
      const { name, country } = splitPlaceAndCountry(spec.place);
      if (!name || tradePhrases(spec).length === 0) return null;
      const cacheKey = areaCacheKey(spec);
      const cached = options.cache?.get(cacheKey);
      if (cached) return { ...cached, fromCache: true };

      const runner = await options.getRunner();
      if (!runner) {
        onProgress?.("Map data is off: the DuckDB package is not installed, so only web search is used.");
        return null;
      }
      const release = await latestOvertureRelease(options.fetchImpl, signal);
      if (!release) {
        onProgress?.("Map data is unavailable right now (could not reach Overture), so only web search is used.");
        return null;
      }
      if (signal?.aborted) return null;
      onProgress?.(`Loading free map data for ${spec.place} (Overture ${release}). The first load of an area takes a minute or two.`);
      const division = pickDivision(await runner(buildDivisionSql(release, name, country)), country);
      if (!division) {
        onProgress?.(`Could not find "${name}" in the map data, so only web search is used. Try the town's full name.`);
        return null;
      }
      if (signal?.aborted) return null;
      const rows = await runner(buildPlacesSql(release, division.bbox, tradePhrases(spec)));
      const mapped = rows.map((row) => mapOverturePlace(row.j)).filter((place): place is AreaPlace => Boolean(place));
      const places = filterAreaPlaces(mapped, spec, division.name);
      const load: AreaLoad = {
        places,
        areaName: `${division.name}${division.country ? `, ${division.country}` : ""}`,
        country: division.country,
        release,
        fromCache: false,
      };
      options.cache?.set(cacheKey, load);
      return load;
    },
  };
}
