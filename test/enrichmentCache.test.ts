import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

process.env.APEX_DB_PATH = path.join(os.tmpdir(), `apex-cache-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);

const db = await import('../server/db.ts');
const { enrichLeadProfile } = await import('../server/leadSearch/profileEnrichment.ts');

describe('enrichment cache', () => {
  it('initializes a versioned database schema', () => {
    const version = db.getLeadsDb().prepare('PRAGMA user_version').get() as { user_version: number };
    // Bumped to 24 by schema v24 (lead kind and source for business leads).
    assert.equal(version.user_version, 24);
    const companiesTable = db.getLeadsDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovered_companies'").get();
    assert.ok(companiesTable);
    const emailCache = db.getLeadsDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_discovery_cache'").get();
    assert.equal(emailCache, undefined);
    const ftsTable = db.getLeadsDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'leads_fts'").get();
    assert.ok(ftsTable);
    const cacheColumns = db.getLeadsDb().prepare('PRAGMA table_info(enrichment_cache)').all() as { name: string }[];
    assert.ok(cacheColumns.some(column => column.name === 'public_email'));
    assert.ok(cacheColumns.some(column => column.name === 'intent_fingerprint'));
    const sessionColumns = db.getLeadsDb().prepare('PRAGMA table_info(mining_sessions)').all() as { name: string }[];
    assert.ok(sessionColumns.some(column => column.name === 'checkpoint_json'));
    const performanceColumns = db.getLeadsDb().prepare('PRAGMA table_info(query_performance)').all() as { name: string }[];
    for (const column of ['outcome_runs', 'qualified_candidates', 'rescued_candidates', 'returned_candidates', 'search_latency_ms', 'provider_units', 'judged_candidates', 'hard_failed_candidates', 'unknown_candidates', 'requirement_fail_digest']) {
      assert.ok(performanceColumns.some(candidate => candidate.name === column));
    }
    const savedSearchColumns = db.getLeadsDb().prepare('PRAGMA table_info(saved_searches)').all() as { name: string }[];
    assert.ok(savedSearchColumns.some(column => column.name === 'exclude_list_json'));
    const identityTable = db.getLeadsDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lead_identities'").get();
    assert.ok(identityTable);
  });

  it('persists and retrieves intent cache entries by website and intent_fingerprint', () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    db.upsertIntentCacheEntry({
      normalizedUrl: 'https://phemeai.io',
      companyName: 'Pheme AI',
      evidenceBlock: JSON.stringify({ websiteUrl: 'https://phemeai.io', evidenceQuality: 'good', buyingSignals: ['white label'] }),
      scrapeQuality: 'good',
      sourceProvider: 'brightdata',
      intentFingerprint: 'fingerprint-abc-123'
    }, 7, now);

    const hit = db.getIntentCacheEntry('https://phemeai.io', 'fingerprint-abc-123', new Date('2026-08-02T00:00:00.000Z'));
    assert.ok(hit);
    assert.equal(hit?.intentFingerprint, 'fingerprint-abc-123');

    const missWrongFingerprint = db.getIntentCacheEntry('https://phemeai.io', 'fingerprint-different-xyz', new Date('2026-08-02T00:00:00.000Z'));
    assert.equal(missWrongFingerprint, null);
  });

  it('increments lead revisions and rejects stale writes', () => {
    const baseLead = {
      id: 'revision-test-lead',
      profile: { fullName: 'Revision Test' },
      stage: 'SCRAPED',
      createdAt: '2026-07-11T00:00:00.000Z'
    };
    const created = db.upsertLead(baseLead);
    assert.equal(created.revision, 1);
    const updated = db.upsertLead({ ...created, notes: 'Fresh edit' });
    assert.equal(updated.revision, 2);
    assert.throws(() => db.upsertLead({ ...created, notes: 'Stale edit' }), db.LeadRevisionConflictError);
  });

  it('persists mining session state independently of live memory', () => {
    const created = db.upsertMiningSession({
      id: 'mining-session-test',
      status: 'running',
      prompt: 'Dentists in Austin',
      requestedLimit: 5,
      startedAt: '2026-07-11T00:00:00.000Z'
    });
    assert.equal(created.status, 'running');
    const completed = db.upsertMiningSession({
      id: created.id,
      status: 'success',
      completedAt: '2026-07-11T00:01:00.000Z',
      stats: { accepted: 3 }
    });
    assert.equal(completed.stats?.accepted, 3);
    assert.equal(db.readMiningSessionById(created.id)?.status, 'success');
  });

  it('returns unexpired cache hits by URL and username', () => {
    const now = new Date('2026-06-25T00:00:00.000Z');
    db.upsertEnrichmentCacheEntry({
      normalizedUrl: 'linkedin.com/in/jane-doe',
      linkedinUsername: 'jane-doe',
      personName: 'Jane Doe',
      companyName: 'Acme Dental Growth',
      publicEmail: 'jane@acme.test',
      evidenceBlock: 'NAME: Jane Doe\nHEADLINE: Founder at Acme Dental Growth',
      scrapeQuality: 'good',
      sourceProvider: 'brightdata'
    }, 7, now);

    const byUrl = db.getEnrichmentCacheEntry({ normalizedUrl: 'linkedin.com/in/jane-doe' }, new Date('2026-06-26T00:00:00.000Z'));
    const byUsername = db.getEnrichmentCacheEntry({ linkedinUsername: 'jane-doe' }, new Date('2026-06-26T00:00:00.000Z'));

    assert.equal(byUrl?.sourceProvider, 'brightdata');
    assert.equal(byUrl?.publicEmail, 'jane@acme.test');
    assert.equal(byUsername?.evidenceBlock.includes('Jane Doe'), true);
  });

  it('normalizes legacy workflow and email metadata without losing the address', () => {
    const stored = db.upsertLead({
      id: 'legacy-email-lead',
      profile: { fullName: 'Legacy Email', contactDetails: { emailStatus: 'confirmed_public' } },
      emailDiscovery: { bestEmail: 'Legacy@Example.org', status: 'confirmed_public' },
      stage: 'SCRAPED',
      createdAt: '2026-07-11T00:00:00.000Z',
    });
    assert.equal(stored.profile.contactDetails.email, 'legacy@example.org');
    assert.equal(stored.profile.contactDetails.emailStatus, undefined);
    assert.equal(stored.emailDiscovery, undefined);
    assert.equal(stored.reviewStatus, 'UNREVIEWED');
    assert.equal(stored.nextAction, 'NONE');
  });

  it('uses cached profile evidence and fills only an empty CRM email', async () => {
    db.upsertEnrichmentCacheEntry({
      normalizedUrl: 'linkedin.com/in/jane-cache',
      linkedinUsername: 'jane-cache',
      personName: 'Jane Doe',
      companyName: 'Acme Dental Growth',
      publicEmail: 'jane@acme.test',
      evidenceBlock: 'NAME: Jane Doe\nHEADLINE: Founder at Acme Dental Growth\nEMAIL: jane@acme.test',
      scrapeQuality: 'good',
      sourceProvider: 'brightdata',
    }, 7, new Date());
    const base = {
      id: 'cache-profile-lead',
      profile: {
        id: 'cache-profile',
        fullName: 'Jane Doe',
        currentCompany: 'Acme Dental Growth',
        contactDetails: { linkedinUrl: 'https://linkedin.com/in/jane-cache' },
      },
      stage: 'SCRAPED',
      createdAt: '2026-07-11T00:00:00.000Z',
    };
    const cached = await enrichLeadProfile(structuredClone(base), { force: false });
    assert.equal(cached.result.status, 'cache_hit');
    assert.equal(cached.result.scraped, false);
    assert.equal(cached.lead.profile.contactDetails.email, 'jane@acme.test');

    const existing: any = structuredClone(base);
    existing.profile.contactDetails.email = 'manual@acme.test';
    const preserved = await enrichLeadProfile(existing, { force: false });
    assert.equal(preserved.lead.profile.contactDetails.email, 'manual@acme.test');
  });

  it('uses person and company fallback for URL variants', () => {
    const hit = db.getEnrichmentCacheEntry({ personName: 'Jane Doe', companyName: 'Acme Dental Growth' }, new Date('2026-06-26T00:00:00.000Z'));
    assert.equal(hit?.linkedinUsername, 'jane-cache');
  });

  it('prunes expired cache rows after the TTL', () => {
    db.upsertEnrichmentCacheEntry({
      normalizedUrl: 'linkedin.com/in/expired-case',
      linkedinUsername: 'expired-case',
      evidenceBlock: 'NAME: Expired Case\nHEADLINE: Founder at Old Co',
      scrapeQuality: 'partial',
      sourceProvider: 'brightdata',
    }, 1, new Date('2026-06-25T00:00:00.000Z'));
    const deleted = db.pruneExpiredEnrichmentCache(new Date('2026-07-05T00:00:00.000Z'));
    assert.ok(deleted >= 1);
    const miss = db.getEnrichmentCacheEntry({ linkedinUsername: 'expired-case' }, new Date('2026-07-05T00:00:00.000Z'));
    assert.equal(miss, null);
  });
});
