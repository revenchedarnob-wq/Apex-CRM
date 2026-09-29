import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// ISOLATION GUARD: Ensure test executes against an isolated throwaway database
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-api-limits-"));
process.env.APEX_DB_PATH = path.join(testDbDir, "test.sqlite");

const {
  readLeadsSummary,
  readLeadActivities,
  readOutreachDrafts,
  getLeadsETag,
  invalidateLeadsStatsCache,
  upsertLeadWithIdentity,
  readStoredLeadById,
  closeLeadsDb,
} = await import("../server/db.ts");

const {
  parseOptionalPositiveInt,
  parseBoundedLimit,
} = await import("../server/routes/api.ts");

describe("API and DB Limit Validation (Findings 3, 4, 5, 17)", () => {
  after(() => {
    if (typeof closeLeadsDb === "function") {
      closeLeadsDb();
    }
    try {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    } catch {}
  });
  it("parseOptionalPositiveInt handles valid, NaN, negative, and empty inputs", () => {
    assert.equal(parseOptionalPositiveInt(50), 50);
    assert.equal(parseOptionalPositiveInt("50"), 50);
    assert.equal(parseOptionalPositiveInt("123.45"), 123);
    assert.equal(parseOptionalPositiveInt("abc"), undefined);
    assert.equal(parseOptionalPositiveInt(""), undefined);
    assert.equal(parseOptionalPositiveInt(undefined), undefined);
    assert.equal(parseOptionalPositiveInt(null), undefined);
    assert.equal(parseOptionalPositiveInt(-1), undefined);
    assert.equal(parseOptionalPositiveInt(0), undefined);
    assert.equal(parseOptionalPositiveInt(NaN), undefined);
  });

  it("parseBoundedLimit defaults when input is NaN or invalid without silent truncation to 1", () => {
    // Finding 3 fix verification: limit=abc or limit='' falls back to defaultLimit (e.g. 50), not 1
    assert.equal(parseBoundedLimit("abc", 50, 5000), 50);
    assert.equal(parseBoundedLimit("", 50, 5000), 50);
    assert.equal(parseBoundedLimit(undefined, 50, 5000), 50);
    assert.equal(parseBoundedLimit(-10, 50, 5000), 50);
    assert.equal(parseBoundedLimit(NaN, 50, 5000), 50);

    // Bounded values respected
    assert.equal(parseBoundedLimit("25", 50, 5000), 25);
    assert.equal(parseBoundedLimit(10000, 50, 5000), 5000);
    assert.equal(parseBoundedLimit(1, 50, 5000), 1);
  });

  it("readLeadsSummary safely handles NaN, negative, and positive limits without crash or unbounded scan", () => {
    // Should execute safely without throwing SQLite datatype mismatch
    const resValid = readLeadsSummary({ limit: 10 });
    assert.ok(Array.isArray(resValid.leads));
    assert.ok(resValid.leads.length <= 10);

    const resNan = readLeadsSummary({ limit: NaN });
    assert.ok(Array.isArray(resNan.leads));

    const resNegative = readLeadsSummary({ limit: -1 });
    assert.ok(Array.isArray(resNegative.leads));
  });

  it("readLeadActivities and readOutreachDrafts safely clamp NaN and -1", () => {
    // Finding 4 and 5 fix verification: no datatype mismatch on NaN, no unbounded scan on -1
    const activitiesNan = readLeadActivities("non-existent-lead", NaN);
    assert.ok(Array.isArray(activitiesNan));
    assert.equal(activitiesNan.length, 0);

    const activitiesNeg = readLeadActivities("non-existent-lead", -1);
    assert.ok(Array.isArray(activitiesNeg));

    const draftsNan = readOutreachDrafts(NaN);
    assert.ok(Array.isArray(draftsNan));

    const draftsNeg = readOutreachDrafts(-1);
    assert.ok(Array.isArray(draftsNeg));
  });

  it("getLeadsETag is deterministic across mutation counter increments when durable state is identical (Finding 17)", () => {
    const etag1 = getLeadsETag({ stage: "all" });
    // Invalidate stats/mutation counter to simulate mutation counter change
    invalidateLeadsStatsCache();
    const etag2 = getLeadsETag({ stage: "all" });
    assert.equal(etag1, etag2, "ETag must be derived from durable SQLite state, not ephemeral in-memory counter");
  });

  it("getLeadsETag changes when a lead is edited within the same millisecond (Finding 17)", (t) => {
    // Freeze the clock so both writes share one updated_at; only the revision bump can
    // distinguish them now that the in-memory mutation counter is out of the hash.
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00.000Z") });
    upsertLeadWithIdentity({
      id: "etag-lead",
      fullName: "ETag Lead",
      sourceUrl: "https://linkedin.com/in/etag-lead",
      stage: "SCRAPED",
    });
    const before = getLeadsETag({ stage: "all" });
    const stored = readStoredLeadById("etag-lead");
    upsertLeadWithIdentity({ ...stored, stage: "QUALIFIED" });
    const after = getLeadsETag({ stage: "all" });
    assert.notEqual(before, after, "an edit must invalidate the ETag even when updated_at is unchanged");
  });
});
