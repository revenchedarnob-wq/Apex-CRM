import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseBusinessBrief } from '../server/businessSearch/brief.ts';
import { estimateCoverage } from '../server/businessSearch/coverage.ts';
import { areaNamesFromPlaces, buildAreaQueries, buildNameLookupQuery, pickLookupHit } from '../server/businessSearch/lookup.ts';
import {
  buildDivisionSql,
  buildPlacesSql,
  createOvertureAreaSource,
  filterAreaPlaces,
  latestOvertureRelease,
  mapOverturePlace,
  pickDivision,
} from '../server/businessSearch/overture.ts';
import {
  addressCountry,
  checkPlaceMatch,
  extractPostcode,
  nameSimilarity,
  placeMatchesTrade,
  postcodeDistrict,
  splitPlaceAndCountry,
  tradePhrases,
  type AreaPlace,
} from '../server/businessSearch/places.ts';
import { runBusinessSearch } from '../server/businessSearch/pipeline.ts';
import { collectCandidates } from '../server/businessSearch/rounds.ts';
import { facebookPagesInHtml, findFacebookOnWebsite } from '../server/businessSearch/websiteLinks.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const place = (overrides: Partial<AreaPlace> = {}): AreaPlace => ({
  id: 'overture:1',
  name: 'Holy Grain Sourdough',
  categories: ['bakery'],
  address: '1 Mews, Manchester, M1 1AA',
  city: 'Manchester',
  postcode: 'M11AA',
  country: 'GB',
  phones: ['0161 555 0100'],
  websites: ['https://holygrain.co.uk'],
  emails: [],
  facebookPages: [],
  source: 'overture',
  ...overrides,
});

const spec = parseBusinessBrief('bakeries in Manchester, UK');

describe('places helpers', () => {
  test('splits a country off the place', () => {
    assert.deepEqual(splitPlaceAndCountry('Manchester, UK'), { name: 'Manchester', country: 'GB' });
    assert.deepEqual(splitPlaceAndCountry('Austin, TX'), { name: 'Austin', country: 'US' });
    assert.deepEqual(splitPlaceAndCountry('Leeds'), { name: 'Leeds' });
  });

  test('knows common synonyms for a trade', () => {
    assert.ok(tradePhrases(spec).includes('cake shop'));
    assert.ok(placeMatchesTrade({ name: 'Sy Cake', categories: ['cake shop'] }, spec));
    assert.ok(!placeMatchesTrade({ name: 'Joe Plumbing', categories: ['plumber'] }, spec));
  });

  test('reads postcodes and countries from addresses', () => {
    assert.equal(extractPostcode('223 Hill Ln, Manchester M9 6RG, UK'), 'M96RG');
    assert.equal(postcodeDistrict('M14 5ED'), 'M14');
    assert.equal(addressCountry('1 Elm St, Manchester, NH 03101'), 'US');
    assert.equal(addressCountry('12 High St, Manchester M1 1AA'), 'GB');
    assert.equal(addressCountry('Somewhere'), '');
  });

  test('compares business names', () => {
    assert.equal(nameSimilarity("Lottie's Bakehouse", 'Lotties Bakehouse Manchester'), 1);
    assert.ok(nameSimilarity("Long Boi's Bakehouse", 'longboisbakehouse') >= 0.8);
    assert.equal(nameSimilarity('Super Taste Bakery', 'Leeds Bread'), 0);
  });

  test('matches a Page to its map listing by phone, and flags a different business', () => {
    const listing = place();
    assert.equal(checkPlaceMatch(listing, { name: 'Holy Grain', phones: ['+44 161 555 0100'] }).level, 'strong');
    assert.equal(checkPlaceMatch(listing, { name: 'Holy Grain Sourdough Bakery' }).level, 'weak');
    assert.equal(
      checkPlaceMatch(listing, { name: 'Holy Grain', phones: ['+1 603 555 0199'], websites: ['https://other.com'] }).level,
      'conflict',
    );
  });
});

describe('coverage meter', () => {
  test('estimates the total from the overlap of two methods', () => {
    const map = Array.from({ length: 80 }, (_, i) => `p${i}`);
    const search = Array.from({ length: 60 }, (_, i) => `p${i + 32}`);
    const estimate = estimateCoverage(map, search);
    assert.ok(estimate);
    assert.equal(estimate.byBoth, 48);
    assert.equal(estimate.found, 92);
    assert.ok(estimate.estimatedTotal >= 98 && estimate.estimatedTotal <= 101);
    assert.ok(estimate.percent >= 90);
  });

  test('declines to guess without overlap', () => {
    assert.equal(estimateCoverage(['a', 'b', 'c'], ['d', 'e', 'f']), null);
  });
});

describe('website links', () => {
  test('finds the business Page and ignores share buttons', () => {
    const html = `<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
      <a href="https://www.facebook.com/HolyGrainSourdough/">Facebook</a>
      <a href="https://facebook.com/HolyGrainSourdough">f</a>`;
    const pages = facebookPagesInHtml(html);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].key, 'facebook:user:holygrainsourdough');
  });

  test('never throws on a bad site', async () => {
    const page = await findFacebookOnWebsite('https://down.example', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(page, null);
    assert.equal(await findFacebookOnWebsite('https://www.instagram.com/x', { fetchImpl: async () => json(200, {}) }), null);
  });
});

describe('name lookup and area queries', () => {
  test('builds a name query and picks the business own Page', () => {
    const listing = place();
    assert.equal(buildNameLookupQuery(listing), 'site:facebook.com "Holy Grain Sourdough" Manchester');
    const hit = pickLookupHit(listing, [
      { url: 'https://www.facebook.com/GreatNorthernWarehouse/posts/123', title: 'THE HOLY GRAIL OF BAKERIES - Holy Grain' },
      { url: 'https://www.facebook.com/HolyGrainSourdough/', title: 'Holy Grain Sourdough Bakery | Manchester | Facebook' },
    ]);
    assert.equal(hit?.key, 'facebook:user:holygrainsourdough');
    assert.equal(pickLookupHit(listing, [{ url: 'https://www.facebook.com/leedsbread', title: 'Leeds Bread | Facebook' }]), null);
  });

  test('splits the city into postcode districts, busiest first', () => {
    const places = [
      place({ id: 'a', postcode: 'M145ED' }),
      place({ id: 'b', postcode: 'M146AA' }),
      place({ id: 'c', postcode: 'M201AB' }),
    ];
    const areas = areaNamesFromPlaces(places, spec);
    assert.deepEqual(areas, ['M14', 'M20']);
    const queries = buildAreaQueries(spec, areas);
    assert.ok(queries.includes('site:facebook.com bakery M14 Manchester'));
    assert.ok(queries.some((query) => query.includes('cake shop')));
  });
});

describe('Overture map data', () => {
  const record = {
    id: 'abc',
    names: { primary: 'Holy Grain Sourdough' },
    basic_category: 'bakery',
    confidence: 0.92,
    operating_status: 'open',
    addresses: [{ freeform: '1 Mews', locality: 'Manchester', postcode: 'M1 1AA', country: 'GB' }],
    phones: ['+44 161 555 0100'],
    websites: ['https://holygrain.co.uk'],
    socials: ['https://www.facebook.com/HolyGrainSourdough'],
  };

  test('maps a place record and its Facebook link', () => {
    const mapped = mapOverturePlace(JSON.stringify(record));
    assert.ok(mapped);
    assert.equal(mapped.id, 'overture:abc');
    assert.equal(mapped.postcode, 'M11AA');
    assert.equal(mapped.facebookPages[0].key, 'facebook:user:holygrainsourdough');
    assert.deepEqual(mapped.categories, ['bakery']);
  });

  test('drops closed and low-confidence places', () => {
    assert.equal(mapOverturePlace({ ...record, operating_status: 'permanently_closed' }), null);
    assert.equal(mapOverturePlace({ ...record, confidence: 0.2 }), null);
  });

  test('reads old-style categories too', () => {
    const old = { ...record, basic_category: undefined, categories: { primary: 'cake_shop', alternate: ['bakery'] } };
    assert.deepEqual(mapOverturePlace(old)?.categories, ['cake shop', 'bakery']);
  });

  test('keeps places of the trade inside the named town', () => {
    const inTown = mapOverturePlace(record)!;
    const salford = { ...inTown, id: 'overture:x', city: 'Salford', address: '2 Road, Salford' };
    const plumber = { ...inTown, id: 'overture:y', name: 'Pipes Ltd', categories: ['plumber'] };
    assert.deepEqual(filterAreaPlaces([inTown, salford, plumber], spec, 'Manchester').map((p) => p.id), ['overture:abc']);
  });

  test('builds safe SQL', () => {
    const sql = buildPlacesSql('2026-09-23.0', { xmin: -2.3, ymin: 53.4, xmax: -2.1, ymax: 53.5 }, ["bakery", "o'reilly's cakes"]);
    assert.match(sql, /theme=places\/type=place/);
    assert.match(sql, /bbox\.xmin >= -2\.300000/);
    assert.ok(!sql.includes("o'reilly"));
    const division = buildDivisionSql('2026-09-23.0', "St John's", 'GB');
    assert.match(division, /'st john''s'/);
    assert.match(division, /country = 'GB'/);
  });

  test('picks the right town among places with the same name', () => {
    const row = (country: string, subtype: string, population?: number, size = 0.1) => ({
      area: JSON.stringify({ names: { primary: 'Manchester' }, country, subtype, bbox: { xmin: 0, ymin: 0, xmax: size, ymax: size } }),
      division: population ? JSON.stringify({ population }) : null,
    });
    const rows = [row('US', 'locality', 115000), row('GB', 'locality', 550000), row('GB', 'county', 2800000, 1)];
    assert.equal(pickDivision(rows)?.country, 'GB');
    assert.equal(pickDivision(rows, 'US')?.country, 'US');
    assert.equal(pickDivision(rows)?.population, 550000);
  });

  test('finds the latest release from the bucket listing', async () => {
    const xml = '<ListBucketResult><CommonPrefixes><Prefix>release/2026-08-20.0/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>release/2026-09-23.0/</Prefix></CommonPrefixes></ListBucketResult>';
    assert.equal(await latestOvertureRelease(async () => new Response(xml)), '2026-09-23.0');
  });

  test('loads an area once and then serves it from the cache', async () => {
    const store = new Map<string, any>();
    const sqls: string[] = [];
    const source = createOvertureAreaSource({
      getRunner: async () => async (sql) => {
        sqls.push(sql);
        if (sql.includes('theme=divisions')) {
          return [{ area: JSON.stringify({ names: { primary: 'Manchester' }, country: 'GB', subtype: 'locality', bbox: { xmin: -2.3, ymin: 53.4, xmax: -2.1, ymax: 53.5 } }) }];
        }
        return [{ j: JSON.stringify(record) }];
      },
      fetchImpl: async () => new Response('<Prefix>release/2026-09-23.0/</Prefix>'),
      cache: { get: (key) => store.get(key) || null, set: (key, value) => void store.set(key, value) },
    });
    const first = await source.load(spec, {});
    assert.equal(first?.places.length, 1);
    assert.equal(first?.areaName, 'Manchester, GB');
    assert.equal(first?.fromCache, false);
    const second = await source.load(spec, {});
    assert.equal(second?.fromCache, true);
    assert.equal(sqls.length, 2);
  });

  test('without DuckDB the search carries on with web search only', async () => {
    const messages: string[] = [];
    const source = createOvertureAreaSource({ getRunner: async () => null, fetchImpl: async () => new Response('') });
    assert.equal(await source.load(spec, { onProgress: (m) => messages.push(m) }), null);
    assert.match(messages[0], /DuckDB/);
  });
});

describe('collection rounds', () => {
  const areaSource = (places: AreaPlace[]) => ({
    load: async () => ({ places, areaName: 'Manchester, GB', country: 'GB', fromCache: false }),
  });

  test('uses map links first, then websites, then name lookups, and stops at the target', async () => {
    const places = [
      place({ id: 'm1', name: 'Mapped Bakery', facebookPages: [{ key: 'facebook:user:mappedbakery', url: 'https://www.facebook.com/mappedbakery', username: 'mappedbakery' }] }),
      place({ id: 'w1', name: 'Site Bakery', websites: ['https://sitebakery.co.uk'] }),
      place({ id: 'n1', name: 'Named Bakery', websites: [] }),
      place({ id: 'n2', name: 'Other Bakery', websites: [] }),
    ];
    const lookups: string[] = [];
    const result = await collectCandidates(
      spec,
      { target: 3 },
      {
        areaSource: areaSource(places),
        websiteFetch: async () =>
          new Response('<a href="https://www.facebook.com/sitebakery">fb</a>', { headers: { 'content-type': 'text/html' } }),
        brightDataSearch: async (query) => {
          if (query.includes('"Named Bakery"')) {
            lookups.push(query);
            return [{ url: 'https://www.facebook.com/namedbakery', title: 'Named Bakery | Manchester | Facebook' }];
          }
          if (query.includes('"')) {
            lookups.push(query);
            return [];
          }
          return [];
        },
      },
    );
    assert.deepEqual(result.candidates.map((c) => c.key), [
      'facebook:user:mappedbakery',
      'facebook:user:sitebakery',
      'facebook:user:namedbakery',
    ]);
    assert.deepEqual(result.candidates.map((c) => c.via[0]), ['map', 'website', 'name']);
    assert.equal(result.stats.mapLinked, 1);
    assert.equal(result.stats.websiteLinked, 1);
    assert.equal(result.stats.nameMatched, 1);
    assert.equal(result.candidates[2].place?.id, 'n1');
  });

  test('skips Pages already in the CRM but counts them for coverage', async () => {
    const known = 'facebook:user:mappedbakery';
    const result = await collectCandidates(
      spec,
      { target: 5, existingKeys: new Set([known]) },
      {
        areaSource: areaSource([
          place({ id: 'm1', facebookPages: [{ key: known, url: 'https://www.facebook.com/mappedbakery', username: 'mappedbakery' }] }),
        ]),
      },
    );
    assert.equal(result.candidates.length, 0);
    assert.equal(result.stats.skippedKnown, 1);
  });
});

describe('pipeline with map data', () => {
  test('fills contact gaps from the map, rejects wrong matches and other countries', async () => {
    const places = [
      place({ id: 'm1', name: 'Mapped Bakery', phones: ['0161 555 0101'], facebookPages: [{ key: 'facebook:user:mappedbakery', url: 'https://www.facebook.com/mappedbakery', username: 'mappedbakery' }] }),
      place({ id: 'n1', name: 'Named Bakery', phones: ['0161 555 0102'], websites: ['https://named.co.uk'] }),
    ];
    const result = await runBusinessSearch(
      { query: 'bakeries in Manchester, UK', limit: 5 },
      {
        areaSource: { load: async () => ({ places, areaName: 'Manchester, GB', country: 'GB', fromCache: false }) },
        tavilySearch: async (query) =>
          query.includes('"Named Bakery"')
            ? [{ url: 'https://www.facebook.com/namedbakery', title: 'Named Bakery | Facebook' }]
            : [{ url: 'https://www.facebook.com/nhbakery', title: 'NH Bakery | Manchester | Facebook' }],
        brightDataToken: 't',
        fetchImpl: async () =>
          json(200, [
            { url: 'https://www.facebook.com/mappedbakery', page_name: 'Mapped Bakery', primary_category: 'Bakery', address: '1 Mews, Manchester M1 1AA' },
            { url: 'https://www.facebook.com/nhbakery', page_name: 'NH Bakery', primary_category: 'Bakery', address: '1 Elm St, Manchester, NH 03101', phones: ['603 555 0100'] },
            { url: 'https://www.facebook.com/namedbakery', page_name: 'Named Bakery', primary_category: 'Bakery', address: '9 Road, Manchester', phones: ['+1 212 555 0100'], websites: ['https://elsewhere.com'] },
          ]),
      },
    );
    const names = result.leads.map((lead) => lead.business.name);
    assert.deepEqual(names, ['Mapped Bakery']);
    assert.deepEqual(result.leads[0].business.phones, ['0161 555 0101']);
    assert.ok(result.leads[0].evidenceReasons.includes('Found in map data'));
    const reasons = result.rejected.map((r) => r.reasons.join(' '));
    assert.ok(reasons.some((reason) => /in US, not GB/.test(reason)));
    assert.ok(reasons.some((reason) => /differ from the map listing/.test(reason)));
    assert.equal(result.stats.rounds.mapLinked, 1);
    assert.equal(result.stats.area?.name, 'Manchester, GB');
  });
});

describe('chains', () => {
  test('leaves chain branches out when the brief asks for local businesses', async () => {
    const chain = place({ id: 'c1', name: 'Greggs', brand: 'Greggs', facebookPages: [{ key: 'facebook:id:107111544196150', url: 'https://www.facebook.com/profile.php?id=107111544196150', pageId: '107111544196150' }] });
    const local = place({ id: 'l1', name: 'Holy Grain', facebookPages: [{ key: 'facebook:user:holygrainsourdough', url: 'https://www.facebook.com/holygrainsourdough', username: 'holygrainsourdough' }] });
    const areaSource = { load: async () => ({ places: [chain, local], areaName: 'Manchester, GB', fromCache: false }) };
    const localRun = await collectCandidates(parseBusinessBrief('independent bakeries in Manchester'), { target: 5 }, { areaSource });
    assert.deepEqual(localRun.candidates.map((c) => c.place?.name), ['Holy Grain']);
    const anyRun = await collectCandidates(spec, { target: 5 }, { areaSource });
    assert.equal(anyRun.candidates.length, 2);
  });

  test('keeps the brand from Overture', () => {
    const mapped = mapOverturePlace({ id: 'g', names: { primary: 'Greggs' }, brand: { names: { primary: 'Greggs' } }, basic_category: 'bakery' });
    assert.equal(mapped?.brand, 'Greggs');
  });
});

test('"independent" is not read as part of the trade', () => {
  assert.deepEqual(parseBusinessBrief('independent family-run bakeries in Manchester').categoryTerms, ['bakery']);
});

test('rebuilds a bare profile.php Page link from the record id (live record shape)', async () => {
  const { mapPageRecord } = await import('../server/businessSearch/facebookPages.ts');
  const mapped = mapPageRecord({ url: 'https://www.facebook.com/profile.php', page_name: 'Wong Wong Bakery', id: '100045069198459' });
  assert.equal(mapped?.pageUrl, 'https://www.facebook.com/profile.php?id=100045069198459');
});

test('a Page in a synonym category still qualifies', async () => {
  const { qualifyBusiness } = await import('../server/businessSearch/qualify.ts');
  const result = qualifyBusiness({ name: 'Vanilla Ice Cakes', category: 'Cupcake Shop', address: '1 Road, Manchester', dataQuality: 'full' }, spec);
  assert.equal(result.checks.category, 'pass');
});

describe('businesses with no Facebook Page', () => {
  const mapped = place({ id: 'm1', name: 'Mapped Bakery', phones: ['0161 555 0101'], websites: [], facebookPages: [{ key: 'facebook:user:mappedbakery', url: 'https://www.facebook.com/mappedbakery', username: 'mappedbakery' }] });
  const noPage = place({ id: 'p1', name: 'Quiet Loaf', phones: ['0161 555 0199'], websites: ['https://quietloaf.co.uk'] });
  const noContact = place({ id: 'p2', name: 'Ghost Bakery', phones: [], websites: [] });
  const deps = (existingKeys = new Set<string>()) => ({
    areaSource: { load: async () => ({ places: [mapped, noPage, noContact], areaName: 'Manchester, GB', country: 'GB', fromCache: false }) },
    websiteFetch: async () => new Response('<p>no social links</p>', { headers: { 'content-type': 'text/html' } }),
    tavilySearch: async () => [],
    existingKeys,
  });

  test('keeps map businesses with a phone or website, after the Facebook ones', async () => {
    const result = await runBusinessSearch({ query: 'bakeries in Manchester, UK', limit: 5 }, deps());
    assert.deepEqual(result.leads.map((lead) => lead.business.name), ['Mapped Bakery', 'Quiet Loaf']);
    const lead = result.leads[1];
    assert.equal(lead.source, 'maps');
    assert.equal(lead.nextAction, 'CALL');
    assert.equal(lead.business.pageUrl, undefined);
    assert.deepEqual(lead.tags, ['no-facebook']);
    assert.ok(lead.evidenceReasons.some((reason: string) => /No Facebook Page found/.test(reason)));
    assert.equal(result.stats.mapOnly, 1);
  });

  test('can be turned off, and skips businesses already in the CRM', async () => {
    const off = await runBusinessSearch({ query: 'bakeries in Manchester, UK', limit: 5, includeMapOnly: false }, deps());
    assert.deepEqual(off.leads.map((lead) => lead.business.name), ['Mapped Bakery']);
    const known = await runBusinessSearch({ query: 'bakeries in Manchester, UK', limit: 5 }, deps(new Set(['domain:quietloaf.co.uk'])));
    assert.equal(known.stats.mapOnly, 0);
  });

  test('are left out when the brief asks for followers', async () => {
    const result = await runBusinessSearch({ query: 'bakeries in Manchester, UK with 500+ followers', limit: 5 }, deps());
    assert.equal(result.stats.mapOnly, 0);
  });
});
