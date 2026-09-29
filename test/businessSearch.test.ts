import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseBusinessBrief } from '../server/businessSearch/brief.ts';
import { buildDiscoveryQueries, filterPageHits } from '../server/businessSearch/discover.ts';
import { mapPageRecord, readFacebookPages, scrapePagesBatch } from '../server/businessSearch/facebookPages.ts';
import { extractOwnerName, qualifyBusiness } from '../server/businessSearch/qualify.ts';
import { nameFromSearchTitle, runBusinessSearch } from '../server/businessSearch/pipeline.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const bakeryRecord = {
  url: 'https://www.facebook.com/sweetcrumbsmcr',
  page_name: 'Sweet Crumbs',
  username: 'sweetcrumbsmcr',
  id: '100012345678',
  primary_category: 'Bakery',
  summary_text: 'Family bakery owned by Jane Smith. Wedding cakes to order.',
  address: '12 High St, Manchester M1 1AA',
  phones: ['+44 161 555 0100'],
  emails: ['Hello@SweetCrumbs.co.uk'],
  websites: ['https://sweetcrumbs.co.uk'],
  followers: '2.4K',
  rating: 4.8,
  is_verified: false,
};

describe('business brief', () => {
  test('parses category, place, followers and extras', () => {
    const spec = parseBusinessBrief('Bakeries in Manchester with over 1,000 followers that do wedding cakes');
    assert.ok(spec.categoryTerms.includes('bakery'));
    assert.match(spec.place, /Manchester/);
    assert.equal(spec.minFollowers, 1000);
    assert.ok(spec.extras.some((extra) => /wedding cake/.test(extra)));
  });

  test('queries keep category and place', () => {
    const queries = buildDiscoveryQueries(parseBusinessBrief('plumbers in Leeds'));
    assert.ok(queries.length >= 4);
    for (const query of queries) {
      assert.match(query, /plumber/);
      assert.match(query, /Leeds/);
    }
  });
});

describe('page filtering', () => {
  test('keeps Pages, drops non-Pages, duplicates and known leads', () => {
    const hit = (url: string) => ({ url, title: 't', content: '', query: 'q', provider: 'tavily' as const });
    const result = filterPageHits(
      [
        hit('https://www.facebook.com/sweetcrumbsmcr'),
        hit('https://m.facebook.com/sweetcrumbsmcr/about'),
        hit('https://www.facebook.com/groups/bakers'),
        hit('https://example.com'),
        hit('https://www.facebook.com/knownbakery'),
      ],
      new Set(['facebook:user:knownbakery']),
    );
    assert.equal(result.pages.length, 1);
    assert.equal(result.skippedDuplicate, 1);
    assert.equal(result.skippedNotPage, 2);
    assert.equal(result.skippedKnown, 1);
  });

  test('cleans names from search titles', () => {
    assert.equal(nameFromSearchTitle('Sweet Crumbs - Home | Facebook'), 'Sweet Crumbs');
  });
});

describe('Bright Data Page records', () => {
  test('maps a record to business details', () => {
    const business = mapPageRecord(bakeryRecord)!;
    assert.equal(business.name, 'Sweet Crumbs');
    assert.equal(business.category, 'Bakery');
    assert.equal(business.followers, 2400);
    assert.deepEqual(business.emails, ['hello@sweetcrumbs.co.uk']);
    assert.equal(business.pageId, '100012345678');
    assert.equal(business.dataQuality, 'full');
  });

  test('rejects error records', () => {
    assert.equal(mapPageRecord({ error: 'dead page', url: 'x' }), null);
  });

  test('handles a synchronous 200 answer', async () => {
    const records = await scrapePagesBatch(['https://www.facebook.com/sweetcrumbsmcr'], {
      token: 't',
      fetchImpl: async () => json(200, [bakeryRecord]),
    });
    assert.equal(records.length, 1);
  });

  test('handles 202 by polling and downloading the snapshot', async () => {
    const calls: string[] = [];
    let polls = 0;
    const records = await scrapePagesBatch(['https://www.facebook.com/sweetcrumbsmcr'], {
      token: 't',
      pollMs: 1,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes('/scrape')) return json(202, { snapshot_id: 's_abc123' });
        if (url.includes('/progress/')) return json(200, { status: ++polls < 2 ? 'running' : 'ready' });
        return json(200, [bakeryRecord]);
      },
    });
    assert.equal(records.length, 1);
    assert.ok(calls.some((url) => url.includes('/snapshot/s_abc123')));
  });

  test('uses the cache and marks failed batches', async () => {
    const cached = mapPageRecord(bakeryRecord)!;
    let fetches = 0;
    const out = await readFacebookPages(
      [
        { key: 'facebook:user:sweetcrumbsmcr', url: 'https://www.facebook.com/sweetcrumbsmcr' },
        { key: 'facebook:user:other', url: 'https://www.facebook.com/other' },
      ],
      {
        token: 't',
        cache: { get: (key) => (key === 'facebook:user:sweetcrumbsmcr' ? cached : null), set: () => {} },
        fetchImpl: async () => {
          fetches++;
          return json(500, { error: 'boom' });
        },
      },
    );
    assert.equal(out.cached, 1);
    assert.equal(out.failed, 1);
    assert.equal(fetches, 2, 'failed batch is retried once');
    assert.ok(out.results[1].error);
  });
});

describe('qualification', () => {
  const spec = parseBusinessBrief('bakeries in Manchester with over 1000 followers');

  test('qualifies a matching business', () => {
    const q = qualifyBusiness(mapPageRecord(bakeryRecord)!, spec);
    assert.equal(q.verdict, 'qualified');
    assert.ok(q.score > 5);
  });

  test('rejects the wrong city and too few followers', () => {
    const q = qualifyBusiness({ ...mapPageRecord(bakeryRecord)!, address: '1 Main St, Leeds' }, spec);
    assert.equal(q.verdict, 'rejected');
    const low = qualifyBusiness({ ...mapPageRecord(bakeryRecord)!, followers: 50 }, spec);
    assert.equal(low.verdict, 'rejected');
  });

  test('missing address means review, not rejection', () => {
    const { address, ...rest } = mapPageRecord(bakeryRecord)!;
    void address;
    assert.equal(qualifyBusiness(rest, spec).verdict, 'maybe');
  });

  test('extracts owner names without guessing', () => {
    assert.deepEqual(extractOwnerName('Family bakery owned by Jane Smith.'), { name: 'Jane Smith', confidence: 0.85 });
    assert.equal(extractOwnerName('owned by our lovely team'), null);
    assert.equal(extractOwnerName(undefined), null);
  });
});

describe('runBusinessSearch', () => {
  test('runs end to end with fake providers', async () => {
    let saved: Record<string, any>[] = [];
    const result = await runBusinessSearch(
      { query: 'bakeries in Manchester', limit: 5 },
      {
        tavilySearch: async () => [
          { url: 'https://www.facebook.com/sweetcrumbsmcr', title: 'Sweet Crumbs | Facebook', content: '' },
          { url: 'https://www.facebook.com/leedsbread', title: 'Leeds Bread | Facebook', content: '' },
        ],
        brightDataToken: 't',
        fetchImpl: async () =>
          json(200, [
            bakeryRecord,
            { ...bakeryRecord, url: 'https://www.facebook.com/leedsbread', username: 'leedsbread', id: '100099999999', page_name: 'Leeds Bread', address: '2 Road, Leeds' },
          ]),
        persist: (leads) => {
          saved = leads;
          return { created: leads.length, updated: 0, duplicates: 0 };
        },
      },
    );
    assert.equal(result.leads.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(saved[0].kind, 'business');
    assert.equal(saved[0].business.ownerName, 'Jane Smith');
    assert.equal(saved[0].nextAction, 'OPEN_FACEBOOK');
  });

  test('without a token it falls back to search results', async () => {
    const result = await runBusinessSearch(
      { query: 'bakeries', limit: 5 },
      { tavilySearch: async () => [{ url: 'https://www.facebook.com/sweetcrumbsmcr', title: 'Sweet Crumbs Bakery | Facebook', content: '' }] },
    );
    assert.equal(result.leads.length, 1);
    assert.equal(result.leads[0].business.dataQuality, 'partial');
  });

  test('asks for a business type when the brief has none', async () => {
    await assert.rejects(runBusinessSearch({ query: 'in Manchester', limit: 5 }, {}), /kind of business/);
  });
});
