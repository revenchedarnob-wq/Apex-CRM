/**
 * Estimates how many Facebook Pages exist in an area from two independent ways of
 * finding them (map listings and web search), using the Chapman form of the
 * Lincoln-Petersen capture-recapture estimator:
 *
 *   N ~= (A + 1)(B + 1) / (M + 1) - 1
 *
 * where A and B are the Pages each method found and M the Pages both found. If the
 * two methods mostly find the same Pages, few are left undiscovered. The estimate
 * leans low when both methods favour the same kind of Page, so it is shown as an
 * estimate, never as a count.
 */
export type CoverageEstimate = {
  /** Pages found by either method. */
  found: number;
  /** Estimated Pages in the area. Never below `found`. */
  estimatedTotal: number;
  /** found / estimatedTotal, 0-100, rounded. */
  percent: number;
  byMap: number;
  bySearch: number;
  byBoth: number;
};

/** Returns null when the samples are too small for the estimate to mean anything. */
export function estimateCoverage(mapKeys: Iterable<string>, searchKeys: Iterable<string>): CoverageEstimate | null {
  const a = new Set(mapKeys);
  const b = new Set(searchKeys);
  let both = 0;
  for (const key of a) if (b.has(key)) both++;
  const found = new Set([...a, ...b]).size;
  if (a.size < 3 || b.size < 3 || both < 1) return null;
  const chapman = ((a.size + 1) * (b.size + 1)) / (both + 1) - 1;
  const estimatedTotal = Math.max(found, Math.round(chapman));
  return {
    found,
    estimatedTotal,
    percent: Math.round((found / estimatedTotal) * 100),
    byMap: a.size,
    bySearch: b.size,
    byBoth: both,
  };
}

export function describeCoverage(estimate: CoverageEstimate | null): string {
  if (!estimate) return "Not enough overlap between map data and search to estimate coverage yet.";
  return `Coverage: found about ${estimate.percent}% of an estimated ${estimate.estimatedTotal} Pages in this area (${estimate.byMap} from map data, ${estimate.bySearch} from search, ${estimate.byBoth} from both).`;
}
