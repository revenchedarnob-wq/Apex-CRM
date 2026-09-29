import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Explicit per-test database isolation
const testDbPath = path.join(
  os.tmpdir(),
  `test-fts-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

// Import after APEX_DB_PATH is set
const { getLeadsDb, closeLeadsDb, readLeadsSummary, upsertLeadWithIdentity, deleteLead } =
  await import("../server/db.js");

test.after(() => {
  closeLeadsDb();
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch {}
});

test("Stream 1: FTS Integrity, Schema v24, and Zero Fan-out Joins", async (t) => {
  await t.test("Schema version is 24 and company index exists", () => {
    const db = getLeadsDb();
    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(versionRow.user_version, 24, "Schema version must be 24");

    const indexRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_leads_company'",
      )
      .get() as { name?: string } | undefined;
    assert.ok(indexRow?.name, "idx_leads_company index must exist");
  });

  await t.test("FTS triggers maintain leads_fts and leads_fts_map 1:1 on insert and update", () => {
    const db = getLeadsDb();

    // Insert lead 1
    const lead1 = {
      id: "lead-fts-1",
      fullName: "Alice Engineer",
      currentCompany: "Apex Cyber",
      currentTitle: "VP Engineering",
      email: "alice@apexcyber.io",
      notes: "Expert in distributed databases and FTS5 search",
      tags: ["tech", "executive"],
    };
    upsertLeadWithIdentity(lead1);

    // Verify 1:1 insertion in leads_fts and leads_fts_map
    const ftsMapRow = db
      .prepare("SELECT * FROM leads_fts_map WHERE id = ?")
      .get("lead-fts-1") as { id: string; fts_rowid: number };
    assert.ok(ftsMapRow, "leads_fts_map entry must exist");
    assert.equal(ftsMapRow.id, "lead-fts-1");

    const ftsRow = db
      .prepare("SELECT rowid, * FROM leads_fts WHERE rowid = ?")
      .get(ftsMapRow.fts_rowid) as any;
    assert.ok(ftsRow, "leads_fts row must match fts_rowid");
    assert.equal(ftsRow.company, "Apex Cyber");
    assert.equal(ftsRow.title, "VP Engineering");

    // Search using search API (exercises the new leads_fts_map join)
    const searchRes = readLeadsSummary({ search: "distributed databases" });
    assert.equal(searchRes.total, 1, "Must find exactly 1 lead matching notes");
    assert.equal(searchRes.leads[0].id, "lead-fts-1");

    // Update lead
    const updatedLead = {
      ...lead1,
      currentTitle: "CTO & Co-Founder",
      revision: 1,
    };
    upsertLeadWithIdentity(updatedLead);

    // Check updated FTS row
    const updatedFtsMapRow = db
      .prepare("SELECT * FROM leads_fts_map WHERE id = ?")
      .get("lead-fts-1") as { id: string; fts_rowid: number };
    assert.ok(updatedFtsMapRow);
    const updatedFtsRow = db
      .prepare("SELECT rowid, * FROM leads_fts WHERE rowid = ?")
      .get(updatedFtsMapRow.fts_rowid) as any;
    assert.equal(updatedFtsRow.title, "CTO & Co-Founder");

    // Verify count in leads_fts is still exactly 1 (no duplicate rows)
    const countRow = db
      .prepare("SELECT COUNT(*) AS count FROM leads_fts WHERE id = ?")
      .get("lead-fts-1") as { count: number };
    assert.equal(countRow.count, 1, "leads_fts must have exactly 1 row for lead-fts-1");
  });

  await t.test("FTS delete trigger cleans up leads_fts and leads_fts_map cleanly", () => {
    const db = getLeadsDb();
    deleteLead("lead-fts-1");

    const ftsMapRow = db
      .prepare("SELECT * FROM leads_fts_map WHERE id = ?")
      .get("lead-fts-1");
    assert.equal(ftsMapRow, undefined, "leads_fts_map entry must be deleted");

    const ftsRows = db
      .prepare("SELECT * FROM leads_fts WHERE id = ?")
      .all("lead-fts-1");
    assert.equal(ftsRows.length, 0, "leads_fts entries must be completely deleted");

    const searchRes = readLeadsSummary({ search: "distributed databases" });
    assert.equal(searchRes.total, 0, "Deleted lead must not appear in search");
  });
});
