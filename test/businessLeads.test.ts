import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  buildBusinessIdentityKeys,
  buildProfileDedupeKeys,
  canonicalFacebookPage,
  phoneKey,
  websiteDomainKey,
} from '../src/utils/leadDedupe.ts';
import { getLeadKind, getLeadSource } from '../src/utils/leadSource.ts';

const dataDirectory = mkdtempSync(path.join(tmpdir(), 'apex-business-leads-'));
process.env.APEX_DB_PATH = path.join(dataDirectory, 'leads.sqlite');

const { getLeadsDb, readLeadsSummary, readStoredLeadById, upsertLeadWithIdentity } = await import('../server/db.ts');

after(() => {
  getLeadsDb().close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

const createBusinessLead = (id: string, business: Record<string, any>) => ({
  id,
  kind: 'business',
  source: 'facebook',
  profile: {
    id: `profile-${id}`,
    fullName: business.name,
    currentCompany: business.name,
    currentTitle: business.category || '',
    contactDetails: {},
  },
  business,
  stage: 'SCRAPED',
  createdAt: new Date().toISOString(),
});

const createPersonLead = (id: string, fullName: string, website?: string, linkedinUrl?: string) => ({
  id,
  profile: {
    id: `profile-${id}`,
    fullName,
    currentTitle: 'Founder',
    currentCompany: 'Shared Co',
    contactDetails: { ...(website ? { website } : {}), ...(linkedinUrl ? { linkedinUrl } : {}) },
  },
  stage: 'SCRAPED',
  createdAt: new Date().toISOString(),
});

describe('canonicalFacebookPage', () => {
  test('maps host and path variants of one Page to the same key', () => {
    const variants = [
      'https://www.facebook.com/SweetCrumbsBakery',
      'facebook.com/sweetcrumbsbakery/',
      'https://m.facebook.com/SweetCrumbsBakery?ref=page_internal',
      'https://web.facebook.com/SweetCrumbsBakery/about',
      'https://en-gb.facebook.com/SweetCrumbsBakery/posts/123456789',
      'http://fb.com/sweetcrumbsbakery',
    ];
    for (const url of variants) {
      assert.deepEqual(canonicalFacebookPage(url), {
        key: 'facebook:user:sweetcrumbsbakery',
        url: 'https://www.facebook.com/sweetcrumbsbakery',
        username: 'sweetcrumbsbakery',
      }, url);
    }
  });

  test('reads numeric Page ids from profile.php, people, pages and legacy vanity URLs', () => {
    const expected = 'facebook:id:100063512345678';
    assert.equal(canonicalFacebookPage('https://www.facebook.com/profile.php?id=100063512345678')?.key, expected);
    assert.equal(canonicalFacebookPage('https://www.facebook.com/people/Sweet-Crumbs/100063512345678/')?.key, expected);
    assert.equal(canonicalFacebookPage('https://www.facebook.com/pages/Sweet-Crumbs/100063512345678')?.key, expected);
    assert.equal(canonicalFacebookPage('https://www.facebook.com/pages/category/Bakery/Sweet-Crumbs-100063512345678/')?.key, expected);
    assert.equal(canonicalFacebookPage('https://www.facebook.com/Sweet-Crumbs-100063512345678')?.key, expected);
    assert.equal(
      canonicalFacebookPage('https://www.facebook.com/profile.php?id=100063512345678')?.url,
      'https://www.facebook.com/profile.php?id=100063512345678',
    );
  });

  test('rejects groups, events, marketplace, share links and other sites', () => {
    const rejected = [
      'https://www.facebook.com/groups/manchesterbakers',
      'https://www.facebook.com/events/123456789012',
      'https://www.facebook.com/marketplace/item/123456789012',
      'https://www.facebook.com/share/abc123',
      'https://www.facebook.com/watch/?v=123',
      'https://www.facebook.com/profile.php?id=abc',
      'https://www.facebook.com/',
      'https://notfacebook.com/sweetcrumbs',
      'https://www.instagram.com/sweetcrumbs',
      'not a url at all',
      '',
    ];
    for (const url of rejected) {
      assert.equal(canonicalFacebookPage(url), null, url);
    }
  });
});

describe('business identity keys', () => {
  test('website keys ignore shared hosts and normalize www', () => {
    assert.equal(websiteDomainKey('https://www.SweetCrumbs.co.uk/about'), 'domain:sweetcrumbs.co.uk');
    assert.equal(websiteDomainKey('sweetcrumbs.co.uk'), 'domain:sweetcrumbs.co.uk');
    assert.equal(websiteDomainKey('https://linktr.ee/sweetcrumbs'), '');
    assert.equal(websiteDomainKey('https://www.facebook.com/sweetcrumbs'), '');
    assert.equal(websiteDomainKey('localhost'), '');
  });

  test('phone keys keep digits only and fold 00 into +', () => {
    assert.equal(phoneKey('+44 161 496 0000'), 'phone:441614960000');
    assert.equal(phoneKey('0044 (161) 496-0000'), 'phone:441614960000');
    assert.equal(phoneKey('12345'), '');
    assert.equal(phoneKey(''), '');
  });

  test('business keys combine Page, id, username, website and phone', () => {
    const keys = buildBusinessIdentityKeys({
      name: 'Sweet Crumbs',
      pageUrl: 'https://m.facebook.com/SweetCrumbsBakery',
      pageId: '100063512345678',
      websites: ['https://sweetcrumbs.co.uk', 'https://linktr.ee/sweetcrumbs'],
      phones: ['+44 161 496 0000'],
    });
    assert.deepEqual([...keys].sort(), [
      'domain:sweetcrumbs.co.uk',
      'facebook:id:100063512345678',
      'facebook:user:sweetcrumbsbakery',
      'phone:441614960000',
    ]);
  });

  test('client dedupe adds business keys only for business leads', () => {
    const business = { name: 'Sweet Crumbs', pageUrl: 'https://www.facebook.com/sweetcrumbsbakery' };
    assert.ok(buildProfileDedupeKeys({ kind: 'business', business, profile: { fullName: 'Sweet Crumbs' } })
      .has('facebook:user:sweetcrumbsbakery'));
    assert.ok(!buildProfileDedupeKeys({ kind: 'person', business, profile: { fullName: 'Ann Lee' } })
      .has('facebook:user:sweetcrumbsbakery'));
  });
});

describe('lead kind and source', () => {
  test('stored values win and older leads are derived', () => {
    assert.equal(getLeadKind({}), 'person');
    assert.equal(getLeadKind({ business: { name: 'X' } }), 'business');
    assert.equal(getLeadKind({ kind: 'person', business: { name: 'X' } }), 'person');
    assert.equal(getLeadSource({ source: 'manual', business: { pageUrl: 'https://facebook.com/abcde' } }), 'manual');
    assert.equal(getLeadSource({ business: { pageUrl: 'https://facebook.com/abcde' } }), 'facebook');
    assert.equal(getLeadSource({ profile: { contactDetails: { linkedinUrl: 'https://linkedin.com/in/ann-lee' } } }), 'linkedin');
    assert.equal(getLeadSource({ sourceProvider: 'import' }), 'import');
    assert.equal(getLeadSource({ source: 'bogus' }), 'other');
  });
});

describe('business lead persistence', () => {
  test('saves promoted kind and source and sanitizes business details', () => {
    const { lead } = upsertLeadWithIdentity(createBusinessLead('biz-sweet-crumbs', {
      name: '  Sweet Crumbs  ',
      pageUrl: 'https://www.facebook.com/sweetcrumbsbakery',
      pageId: '100063512345678',
      category: 'Bakery',
      phones: ['+44 161 496 0000', '+44 161 496 0000', 42],
      emails: ['Hello@SweetCrumbs.co.uk'],
      websites: ['https://sweetcrumbs.co.uk'],
      followers: 2140,
      rating: 9,
      ownerName: 'Sara Ahmed',
      ownerSource: 'page',
      unexpected: 'dropped',
    }));

    assert.equal(lead.kind, 'business');
    assert.equal(lead.business.name, 'Sweet Crumbs');
    assert.deepEqual(lead.business.phones, ['+44 161 496 0000']);
    assert.deepEqual(lead.business.emails, ['hello@sweetcrumbs.co.uk']);
    assert.equal(lead.business.rating, undefined, 'ratings above 5 are rejected');
    assert.equal(lead.business.unexpected, undefined);

    const row = getLeadsDb()
      .prepare('SELECT kind, source FROM leads WHERE id = ?')
      .get('biz-sweet-crumbs') as { kind: string; source: string };
    assert.deepEqual({ ...row }, { kind: 'business', source: 'facebook' });
  });

  test('the same Page found through a different URL is a duplicate', () => {
    const result = upsertLeadWithIdentity(createBusinessLead('biz-sweet-crumbs-again', {
      name: 'Sweet Crumbs Bakery',
      pageUrl: 'https://m.facebook.com/profile.php?id=100063512345678',
    }));
    assert.equal(result.disposition, 'duplicate');
    assert.equal(result.lead.id, 'biz-sweet-crumbs');
    assert.equal(readStoredLeadById('biz-sweet-crumbs-again'), null);
  });

  test('two businesses sharing a website are one business', () => {
    const result = upsertLeadWithIdentity(createBusinessLead('biz-sweet-crumbs-site', {
      name: 'Sweet Crumbs Cakes',
      pageUrl: 'https://www.facebook.com/sweetcrumbscakes',
      websites: ['https://www.sweetcrumbs.co.uk/contact'],
    }));
    assert.equal(result.disposition, 'duplicate');
    assert.equal(result.lead.id, 'biz-sweet-crumbs');
  });

  test('people at the same company website stay separate leads', () => {
    const first = upsertLeadWithIdentity(
      createPersonLead('person-one', 'Ann Lee', 'https://sharedco.com', 'https://linkedin.com/in/ann-lee-sc'),
    );
    const second = upsertLeadWithIdentity(
      createPersonLead('person-two', 'Bo Chen', 'https://sharedco.com', 'https://linkedin.com/in/bo-chen-sc'),
    );
    assert.notEqual(first.disposition, 'duplicate');
    assert.notEqual(second.disposition, 'duplicate');
    assert.notEqual(first.lead.id, second.lead.id);
  });

  test('lead listing filters by source and kind', () => {
    const facebook = readLeadsSummary({ source: 'facebook' });
    assert.deepEqual(facebook.leads.map((lead: any) => lead.id), ['biz-sweet-crumbs']);
    const people = readLeadsSummary({ kind: 'person', summaryOnly: true });
    assert.ok(people.leads.length >= 2);
    assert.ok(people.leads.every((lead: any) => lead.kind === 'person' && lead.source === 'linkedin'));
  });
});

test('migration to v24 backfills kind and source for existing leads', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'apex-business-migration-'));
  const databasePath = path.join(directory, 'leads.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE leads (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      full_name TEXT,
      company TEXT,
      title TEXT,
      stage TEXT NOT NULL DEFAULT 'NEW',
      review_status TEXT NOT NULL DEFAULT 'UNREVIEWED',
      next_action TEXT NOT NULL DEFAULT 'NONE',
      score REAL,
      email TEXT
    );
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    PRAGMA user_version = 23;
  `);
  const insert = db.prepare('INSERT INTO leads (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)');
  const now = '2026-09-01T00:00:00.000Z';
  insert.run('old-person', JSON.stringify({
    id: 'old-person', profile: { fullName: 'Old Person', contactDetails: { linkedinUrl: 'https://linkedin.com/in/old-person' } },
  }), now, now);
  insert.run('old-import', JSON.stringify({
    id: 'old-import', sourceProvider: 'import', profile: { fullName: 'Imported Person' },
  }), now, now);
  db.close();

  try {
    const script = `
      import { getLeadsDb } from './server/db.ts';
      const db = getLeadsDb();
      const rows = db.prepare('SELECT id, kind, source FROM leads ORDER BY id').all();
      const version = db.prepare('PRAGMA user_version').get();
      console.log(JSON.stringify({ rows, version }));
      db.close();
    `;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, APEX_DB_PATH: databasePath },
    });
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1) || '{}');
    assert.equal(result.version.user_version, 24);
    assert.deepEqual(result.rows, [
      { id: 'old-import', kind: 'person', source: 'import' },
      { id: 'old-person', kind: 'person', source: 'linkedin' },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
