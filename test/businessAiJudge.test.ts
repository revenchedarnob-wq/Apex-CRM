import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { judgeBusinesses, judgeChecks, readBriefWithAi, type AiCall } from '../server/businessSearch/aiJudge.ts';
import { parseBusinessBrief } from '../server/businessSearch/brief.ts';
import { runBusinessSearch } from '../server/businessSearch/pipeline.ts';
import type { AreaPlace } from '../server/businessSearch/places.ts';

const stub = (answers: unknown[] | ((stage: string, prompt: string) => unknown)): AiCall & { calls: string[] } => {
  const calls: string[] = [];
  const fn = (async (prompt: string, _schema: unknown, _system: string, options: { stage: string }) => {
    calls.push(options.stage);
    const answer = typeof answers === 'function' ? answers(options.stage, prompt) : answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as AiCall & { calls: string[] };
  fn.calls = calls;
  return fn;
};

describe('AI reads the brief', () => {
  test('fixes the trade and lists own-words requirements', async () => {
    const rules = parseBusinessBrief('high-end bakeries in Manchester, UK with no online ordering');
    const spec = await readBriefWithAi(
      rules,
      stub([{ trade: 'bakery', place: 'Manchester, UK', requirements: ['Looks high-end', 'Has no online ordering'] }]),
    );
    assert.deepEqual(spec.categoryTerms, ['bakery']);
    assert.equal(spec.place, 'Manchester, UK');
    assert.deepEqual(spec.requirements, ['Looks high-end', 'Has no online ordering']);
  });

  test('ignores a trade or place the brief never mentions', async () => {
    const rules = parseBusinessBrief('bakeries in Leeds');
    const spec = await readBriefWithAi(rules, stub([{ trade: 'florist', place: 'London', requirements: [] }]));
    assert.deepEqual(spec.categoryTerms, rules.categoryTerms);
    assert.equal(spec.place, 'Leeds');
  });
});

describe('AI judges businesses', () => {
  const spec = { ...parseBusinessBrief('bakeries in Leeds'), requirements: ['Makes wedding cakes'] };
  const item = (id: string) => ({ id, business: { name: `Bakery ${id}` }, onFacebook: true });

  test('batches 10 per call and keeps only known ids and verdicts', async () => {
    const ai = stub((_stage, prompt) => ({
      results: [...prompt.matchAll(/id: (\w+)/g)].map((m) => ({ id: m[1], verdict: m[1] === 'b3' ? 'no' : 'match', reason: 'r' }))
        .concat([{ id: 'ghost', verdict: 'match', reason: 'x' }, { id: 'b1', verdict: 'great', reason: 'x' } as any]),
    }));
    const items = Array.from({ length: 12 }, (_, i) => item(`b${i}`));
    const verdicts = await judgeBusinesses(spec, items, ai);
    assert.equal(ai.calls.length, 2);
    assert.equal(verdicts.size, 12);
    assert.equal(verdicts.get('b3')?.verdict, 'no');
    assert.equal(verdicts.has('ghost'), false);
  });

  test('makes no call without businesses, and survives a failed call', async () => {
    const none = stub([]);
    assert.equal((await judgeBusinesses(spec, [], none)).size, 0);
    assert.equal(none.calls.length, 0);
    const errors: unknown[] = [];
    const failing = stub([new Error('rate limited')]);
    const verdicts = await judgeBusinesses(spec, [item('a')], failing, { onError: (e) => errors.push(e) });
    assert.equal(verdicts.size, 0);
    assert.equal(errors.length, 1);
  });
});

describe('pipeline with the AI', () => {
  const place = (id: string, name: string, phone: string): AreaPlace => ({
    id, name, categories: ['bakery'], address: `1 Road, Manchester, M1 1AA`, city: 'Manchester', postcode: 'M11AA', country: 'GB',
    phones: [phone], websites: [], emails: [], source: 'overture',
    facebookPages: [{ key: `facebook:user:${id}`, url: `https://www.facebook.com/${id}`, username: id }],
  });
  const places = [place('weddingco', 'Wedding Cakes Co', '0161 555 0101'), place('breadonly', 'Bread Only', '0161 555 0102')];
  const deps = (ai?: AiCall) => ({
    areaSource: { load: async () => ({ places, areaName: 'Manchester, GB', country: 'GB', fromCache: false }) },
    tavilySearch: async () => [],
    ai,
  });

  test('rules out businesses the AI says fail, and shows its reason', async () => {
    // Lead ids are hashes, so the stub answers by name.
    const byName = stub((stage, prompt) =>
      stage === 'business_brief'
        ? { trade: 'bakery', place: 'Manchester, UK', requirements: ['Makes wedding cakes'] }
        : { results: [...prompt.matchAll(/id: (\S+)\nname: (.+)/g)].map((m) => ({
            id: m[1], verdict: m[2].includes('Wedding') ? 'match' : 'no', reason: m[2].includes('Wedding') ? 'Name says wedding cakes' : 'Only sells bread',
          })) },
    );
    const result = await runBusinessSearch({ query: 'bakeries in Manchester, UK that make wedding cakes', limit: 5 }, deps(byName));
    assert.deepEqual(result.leads.map((lead) => lead.business.name), ['Wedding Cakes Co']);
    assert.equal(result.leads[0].evidenceReasons[0], 'AI check: Name says wedding cakes');
    assert.deepEqual(result.rejected.map((r) => r.reasons[0]), ['AI check: Only sells bread']);
    assert.deepEqual(result.stats.ai, { requirements: ['Makes wedding cakes'], judged: 2, rejected: 1, error: undefined });
    assert.deepEqual(byName.calls, ['business_brief', 'business_judge']);
  });

  test('falls back to rules when the AI is down', async () => {
    const down = stub(() => new Error('no credits'));
    const result = await runBusinessSearch({ query: 'bakeries in Manchester, UK', limit: 5 }, deps(down));
    assert.equal(result.leads.length, 2);
    assert.equal(result.stats.ai.judged, 0);
    assert.match(result.stats.ai.error || '', /no credits/);
  });
});

describe('AI understanding, round two', () => {
  test('reads the count, synonyms and local-only, and checks the count is really in the brief', async () => {
    const rules = parseBusinessBrief('i need ten family bakeries around Leeds');
    const spec = await readBriefWithAi(
      rules,
      stub([{ trade: 'bakery', synonyms: ['cake shop', 'Leeds bakery', 'bakery'], place: 'Leeds', quantity: 10, localOnly: true, requirements: [] }]),
    );
    assert.deepEqual(spec.synonyms, ['cake shop']);
    assert.equal(spec.requestedCount, undefined, '"ten" as a word is not trusted as a number');
    assert.equal(spec.localOnly, true);
    const withDigits = await readBriefWithAi(
      parseBusinessBrief('please get me about 15 salons in Leeds'),
      stub([{ trade: 'hair salon', synonyms: [], place: 'Leeds', quantity: 15, localOnly: false, requirements: [] }]),
    );
    assert.equal(withDigits.requestedCount, 15);
  });

  test('always checks the trade and place, then own-words requirements', () => {
    const spec = { ...parseBusinessBrief('clothing brands in usa'), requirements: ['Sells online'] };
    assert.deepEqual(judgeChecks(spec), [
      'Is a clothing brand, or the same kind of business under another name',
      'Is based in usa',
      'Sells online',
    ]);
  });
});

describe('pipeline: count and to-review businesses', () => {
  const page = (id: string, phone: string, address: string): AreaPlace => ({
    id, name: `Shop ${id}`, categories: ['bakery'], address, city: '', postcode: '', country: 'GB',
    phones: [phone], websites: [], emails: [], source: 'overture',
    facebookPages: [{ key: `facebook:user:${id}`, url: `https://www.facebook.com/${id}`, username: id }],
  });
  const deps = (ai?: AiCall) => ({
    areaSource: {
      load: async () => ({
        places: [page('sure', '0161 555 0111', '1 Road, Manchester, M1 1AA'), page('unsure', '0161 555 0112', '')],
        areaName: 'Manchester, GB', country: 'GB', fromCache: false,
      }),
    },
    tavilySearch: async () => [],
    ai,
  });

  test('"find 1 ..." returns one business even when the box says 25', async () => {
    const result = await runBusinessSearch({ query: 'find 1 bakery in Manchester, UK', limit: 25, includeMapOnly: false }, deps());
    assert.equal(result.leads.length, 1);
  });

  test('the AI settles only the businesses the rules marked for review', async () => {
    const ai = stub((stage, prompt) =>
      stage === 'business_brief'
        ? { trade: 'bakery', synonyms: [], place: 'Manchester, UK', quantity: 0, localOnly: false, requirements: [] }
        : { results: [...prompt.matchAll(/id: (\S+)/g)].map((m) => ({ id: m[1], verdict: 'match', reason: 'Bakery in Manchester' })) },
    );
    const result = await runBusinessSearch({ query: 'bakeries in Manchester, UK', limit: 5 }, deps(ai));
    assert.deepEqual(ai.calls, ['business_brief', 'business_judge']);
    assert.equal(result.stats.ai.judged, 1, 'only the one without an address');
    assert.equal(result.leads.every((lead) => lead.reviewStatus === 'UNREVIEWED'), true);
  });
});
