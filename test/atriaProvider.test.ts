import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { isTransientLLMError } from '../server/leadSearch/sessionHelpers.ts';

const originalFetch = globalThis.fetch;

/**
 * Only the provider keys this suite depends on are touched. This suite deliberately does
 * NOT wipe process.env wholesale: node:test runs files concurrently, so a global wipe
 * leaks into other files that read process.env at call time (a known hazard in this repo).
 */
const MANAGED_KEYS = [
  'OPENAI_API_KEY',
  'BYESU_API_KEY',
  'OPENAI_BASE',
  'OPENAI_MODEL',
  'OPENAI_PROVIDER_NAME',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'TOKEN_HARBOR_API_KEY',
  'TOKEN_HARBOR_ENABLED',
  'ATRIA_API_KEY',
  'ATRIA_BASE',
  'ATRIA_MODEL',
  'ATRIA_PROVIDER_NAME',
  'ATRIA_PRIORITY',
  'ATRIA_MAX_TOKENS',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
] as const;

const envSnapshot: Record<string, string | undefined> = {};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function importLLM(suffix: string): Promise<typeof import('../server/services/llm.ts')> {
  return import(`../server/services/llm.ts?t=${Date.now()}-${suffix}`);
}

describe('Atria provider registration', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('is not registered at all when ATRIA_API_KEY is unset', async () => {
    const llm = await importLLM('atria-absent');
    const ids = llm.getLLMProviderSummaries().map((p: any) => p.id);
    assert.equal(ids.includes('atria'), false);
  });

  it('appends Atria last by default so supplying a key never re-routes a session', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('atria-fallback-order');
    const ids = llm.getLLMProviderSummaries().map((p: any) => p.id);

    assert.equal(ids[0], 'primary');
    assert.equal(ids[ids.length - 1], 'atria');
    assert.equal(llm.getPrimaryLLMProvider(), 'Byesu');
    assert.equal(llm.getPrimaryLLMModel(), 'gpt-5.5');
  });

  it('promotes Atria to the front when ATRIA_PRIORITY=primary', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('atria-promoted');
    const ids = llm.getLLMProviderSummaries().map((p: any) => p.id);

    assert.equal(ids[0], 'atria');
    assert.equal(llm.getPrimaryLLMProvider(), 'Atria');
    assert.equal(llm.getPrimaryLLMModel(), 'Atria-Dawn-Preview');
  });

  it('honours ATRIA_BASE / ATRIA_MODEL overrides and strips trailing slashes', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.ATRIA_BASE = 'https://custom.example/v1/';
    process.env.ATRIA_MODEL = 'custom-model';

    const llm = await importLLM('atria-override');

    let capturedUrl = '';
    let capturedBody: any = null;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url.toString();
      capturedBody = JSON.parse((options as RequestInit).body as string);
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'ok');
    assert.equal(capturedUrl, 'https://custom.example/v1/chat/completions');
    assert.equal(capturedBody.model, 'custom-model');
  });
});

describe('reasoning-model truncation handling', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('cascades to the next provider when reasoning consumes the whole budget', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('truncation-cascade');

    const calls: string[] = [];
    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      if (calls.length === 1) {
        // Atria-Dawn-Preview shape: HTTP 200, content null, reasoning ate the budget.
        return jsonResponse({
          model: 'Atria-Dawn-Preview',
          choices: [
            {
              finish_reason: 'length',
              message: {
                content: null,
                reasoning_content: 'Let me think about this carefully...',
              },
            },
          ],
        });
      }
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }],
      });
    };

    const res = await llm.openAIText('test prompt');

    assert.equal(res.text, 'recovered');
    assert.equal(res.provider, 'Byesu');
    assert.equal(calls.length, 2, 'should have cascaded to the second provider');
    assert.match(calls[0], /atria-asi\.ai/);
    assert.match(calls[1], /byesu\.com/);
  });

  it('surfaces a clear error instead of a silent empty string when every provider truncates', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';

    const llm = await importLLM('truncation-solo');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'length',
            message: { content: null, reasoning_content: 'thinking...' },
          },
        ],
      });

    await assert.rejects(
      () => llm.openAIText('test prompt'),
      (error: Error) => {
        assert.match(error.message, /truncated/);
        assert.match(error.message, /finish_reason "length"/);
        assert.match(error.message, /reasoning_content consumed the entire budget/);
        return true;
      },
    );
  });

  it('does not classify a truncation as a circuit-breaking provider failure', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';

    const llm = await importLLM('truncation-breaker');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'length',
            message: { content: null, reasoning_content: 'thinking...' },
          },
        ],
      });

    // Derive the error from the real code path rather than hand-writing the message, so
    // this assertion cannot pass vacuously if the thrown message is later reworded into
    // something the breaker regexes happen to match.
    let thrown: any = null;
    try {
      await llm.openAIText('test prompt');
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown, 'expected the call to reject');
    const cause = thrown.cause ?? thrown;
    assert.equal(cause.name, 'LLMProviderError');
    assert.match(cause.message, /truncated/);

    // A budget-sizing fault must cascade but must never disable a healthy provider for
    // the rest of the session, so this classification has to stay false.
    assert.equal(llm.isCircuitBreakingProviderFailure(cause), false);
    assert.equal(cause.isTokenLimit, false);
  });

  it('still returns partial content when finish_reason is length but content exists', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';

    const llm = await importLLM('truncation-partial');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [
          { finish_reason: 'length', message: { content: 'partial answer' } },
        ],
      });

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'partial answer');
  });

  it('preserves the existing empty-result behaviour for a non-truncated empty completion', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';

    const llm = await importLLM('empty-stop');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: null } }],
      });

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, '');
  });
});

describe('truncation errors are never retried', () => {
  // The truncation message embeds the reasoning_content character count. A count whose
  // decimal form contains a `5\d\d` run (545, 1500, 5432, ...) satisfies the HTTP-status
  // heuristic in TRANSIENT_LLM_ERROR. Retrying is futile because the token budget is
  // unchanged, so the same provider truncates again on every attempt.
  const truncation = (chars: number) =>
    new Error(
      '[Atria] chat completion truncated: finish_reason "length" produced no visible ' +
        `content (reasoning_content consumed the entire budget: ${chars} chars). Raise max_tokens.`,
    );

  it('reports colliding character counts as non-transient', () => {
    for (const chars of [45, 120, 499, 545, 599, 1500, 5432]) {
      assert.equal(
        isTransientLLMError(truncation(chars)),
        false,
        `${chars} chars must not be retried`,
      );
    }
  });

  it('still treats genuine transport failures as transient', () => {
    for (const message of [
      'chat completion error 503: upstream unavailable',
      'fetch failed',
      'socket hang up',
      'rate limit exceeded (429)',
      'connect ETIMEDOUT 47.236.72.31:443',
    ]) {
      assert.equal(isTransientLLMError(new Error(message)), true, message);
    }
  });

  it('does not classify "timed out" as transient (documented gap, not a regression)', () => {
    // TRANSIENT_LLM_ERROR matches `timeout` / `etimedout` but NOT the two-word form
    // "timed out", even though llm.ts:874 treats `/LLM request timed out after/i` as a
    // gateway-limit condition and llm.ts:529 tests the same string. Severity is limited
    // because sendChatCompletion already retries timeouts in its own fetch-error path, so
    // this outer layer is a second retry rather than the only one. Pinned here so the
    // inconsistency is visible rather than silently inherited; changing it alters retry
    // behaviour engine-wide and should be a deliberate decision.
    assert.equal(isTransientLLMError(new Error('LLM request timed out after 30000ms')), false);
  });
});

describe('Atria consecutive provider priority & dynamic reasoning', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('guarantees exact consecutive provider priority: Atria -> Byesu -> OpenRouter -> Groq -> TokenHarbor', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.TOKEN_HARBOR_API_KEY = 'test-th-key';
    delete process.env.TOKEN_HARBOR_ENABLED;

    const llm = await importLLM('consecutive-priority');
    llm.resetTokenHarborRetirement();

    const ids = llm
      .getLLMProviderSummaries()
      .filter((p: any) => p.configured)
      .map((p: any) => p.id);

    assert.deepEqual(ids, [
      'atria',
      'primary',
      'openrouter',
      'groq',
      'tokenharbor',
    ]);
    assert.equal(llm.getPrimaryLLMProvider(), 'Atria');
    assert.equal(llm.isAtriaPrimary(), true);
    assert.equal(llm.isAtriaConfigured(), true);
  });

  it('clearProviderCooldowns resets 24h quota bans and temporary cooldowns', async () => {
    const llm = await importLLM('cooldown-reset');
    llm.providerCooldowns.set('primary', Date.now() + 24 * 3600 * 1000);
    llm.providerCooldowns.set('atria', Date.now() + 30_000);
    assert.equal(llm.providerCooldowns.size, 2);

    llm.clearProviderCooldowns();
    assert.equal(llm.providerCooldowns.size, 0);
  });

  it('computeAtriaDynamicMaxTokens provides flexible reasoning headroom based on task type and chunk size', async () => {
    const llm = await importLLM('dynamic-tokens');

    // 1. Diagnostics / test truncation calls (<= 50 tokens) are preserved without inflation
    assert.equal(
      llm.computeAtriaDynamicMaxTokens(10, [
        { role: 'user', content: 'test prompt' },
      ]),
      10,
    );

    // 2. General task: requested 4000 + default headroom >= 7000
    const generalBudget = llm.computeAtriaDynamicMaxTokens(4000, [
      { role: 'user', content: 'Hello world' },
    ]);
    assert.ok(
      generalBudget >= 7000,
      `expected >= 7000, got ${generalBudget}`,
    );

    // 3. Heavy extraction chunk (8000 chars evidence): headroom scales up dynamically
    const heavyEvidence = 'A'.repeat(8000);
    const extractionBudget = llm.computeAtriaDynamicMaxTokens(
      4000,
      [{ role: 'user', content: heavyEvidence }],
      { stage: 'extraction', chunkSize: 8000 },
    );
    assert.ok(
      extractionBudget >= 10000,
      `expected extraction budget >= 10000 for 8000-char chunk, got ${extractionBudget}`,
    );
    assert.ok(
      extractionBudget > generalBudget,
      'extraction budget should exceed general budget due to reasoning headroom',
    );

    // 4. Explicit ATRIA_MAX_TOKENS override is respected
    process.env.ATRIA_MAX_TOKENS = '24000';
    const overriddenBudget = llm.computeAtriaDynamicMaxTokens(4000, [
      { role: 'user', content: 'short' },
    ]);
    assert.ok(
      overriddenBudget >= 24000,
      `expected >= 24000, got ${overriddenBudget}`,
    );
  });

  it('passes flexible max_tokens and dynamic timeout to fetch for Atria extraction calls', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';

    const llm = await importLLM('atria-fetch-params');

    let capturedBody: any = null;

    globalThis.fetch = async (_url, options) => {
      capturedBody = JSON.parse((options as RequestInit).body as string);
      return jsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '{"leads":[]}' },
          },
        ],
      });
    };

    const heavyChunk = 'EVIDENCE '.repeat(600); // ~5400 chars
    await llm.openAIStructured(
      `Extract all distinct individuals:\n${heavyChunk}`,
      { type: 'object', properties: { leads: { type: 'array' } } },
      'System prompt',
      {
        maxTokens: 4000,
        metadata: { stage: 'extraction', chunkSize: heavyChunk.length },
      },
    );

    assert.ok(
      capturedBody.max_tokens >= 8000,
      `expected max_tokens >= 8000 for heavy extraction, got ${capturedBody?.max_tokens}`,
    );
  });

  it('keeps Byesu ahead of TokenHarbor when ATRIA_PRIORITY=primary even if ATRIA_API_KEY is unset', async () => {
    delete process.env.ATRIA_API_KEY;
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.TOKEN_HARBOR_API_KEY = 'test-th-key';
    delete process.env.TOKEN_HARBOR_ENABLED;

    const llm = await importLLM('atria-absent-priority');
    llm.resetTokenHarborRetirement();

    const ids = llm
      .getLLMProviderSummaries()
      .filter((p: any) => p.configured)
      .map((p: any) => p.id);

    assert.equal(ids[0], 'primary', 'Byesu must remain primary when Atria key is missing');
    assert.ok(ids.indexOf('primary') < ids.indexOf('tokenharbor'), 'Byesu must precede TokenHarbor');
  });

  it('computeAtriaDynamicMaxTokens scales flexibly without being locked to a static ceiling for large chunks', async () => {
    const llm = await importLLM('large-chunk-budget');

    // Extreme evidence chunk (35,000 chars)
    const massiveChunk = 'X'.repeat(35000);
    const massiveBudget = llm.computeAtriaDynamicMaxTokens(
      4000,
      [{ role: 'user', content: massiveChunk }],
      { stage: 'extraction', chunkSize: 35000 },
    );
    // 4000 base + 35000 * 0.8 (28000) = 32000 tokens
    assert.ok(
      massiveBudget >= 32000,
      `expected budget >= 32000 for 35k-char chunk, got ${massiveBudget}`,
    );

    // Handles empty or malformed messages gracefully
    assert.equal(llm.computeAtriaDynamicMaxTokens(4000, [] as any), 7000);
    assert.equal(
      llm.computeAtriaDynamicMaxTokens(4000, [{ role: 'user', content: undefined as any }]),
      7000,
    );

    // Detects judge stage from prompt text even when metadata is omitted
    const judgeBudget = llm.computeAtriaDynamicMaxTokens(2000, [
      { role: 'user', content: 'Evaluate these candidates and give your final verdict and disqualifications.' },
    ]);
    assert.ok(
      judgeBudget >= 5500,
      `expected judge headroom >= 3500 (total >= 5500), got ${judgeBudget}`,
    );
  });

  it('places Byesu GPT as second priority behind Atria and defaults reasoning_effort to low on structured JSON fallback', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.BYESU_API_KEY = 'test-byesu-key';
    process.env.OPENAI_MODEL = 'gpt-5.6-terra';

    const llm = await importLLM('byesu-second-priority');
    llm.clearProviderCooldowns();

    const configuredIds = llm
      .getLLMProviderSummaries()
      .filter((p: any) => p.configured)
      .map((p: any) => p.id);

    assert.deepEqual(configuredIds.slice(0, 2), ['atria', 'primary']);

    const dynamicTimeout = llm.computeByesuDynamicTimeoutMs(
      4000,
      [{ role: 'user', content: 'Evaluate 10 candidates' }],
      35000,
    );
    assert.ok(
      dynamicTimeout >= 75000,
      `expected Byesu dynamic timeout >= 75000ms instead of 35000ms, got ${dynamicTimeout}`,
    );

    const capturedCalls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse((options as RequestInit).body as string);
      capturedCalls.push({ url: url.toString(), body });
      if (capturedCalls.length === 1) {
        return jsonResponse({ error: { message: 'Atria gateway timeout' } }, 524);
      }
      return jsonResponse({
        model: 'gpt-5.6-terra',
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      });
    };

    const res = await llm.openAIStructured<{ ok: boolean }>(
      'Test fallback to Byesu GPT',
      { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      'Return JSON',
      { maxRetries: 0 },
    );

    assert.equal(res.ok, true);
    assert.equal(capturedCalls.length, 2);
    assert.match(capturedCalls[0].url, /atria-asi\.ai/);
    assert.match(capturedCalls[1].url, /byesu\.com/);
    assert.equal(capturedCalls[1].body.model, 'gpt-5.6-terra');
    assert.equal(capturedCalls[1].body.reasoning_effort, 'low');
  });

  it('recovers from cooldown starvation instead of failing with 0 attempts when Atria and Byesu have overlapping cooldowns', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.BYESU_API_KEY = 'test-byesu-key';

    const llm = await importLLM('cooldown-starvation-recovery');
    llm.clearProviderCooldowns();
    llm.providerCooldowns.set('atria', Date.now() + 60_000);
    llm.providerCooldowns.set('primary', Date.now() + 60_000);

    const breaker = llm.createLLMSessionCircuitBreaker(4);
    breaker.disabledProviderIds.add('atria');

    globalThis.fetch = async () =>
      jsonResponse({
        model: 'gpt-5.5',
        choices: [{ finish_reason: 'stop', message: { content: 'byesu-recovered' } }],
      });

    const res = await llm.openAIText('test prompt', undefined, {
      circuitBreaker: breaker,
      maxRetries: 0,
    });

    assert.equal(res.text, 'byesu-recovered');
    assert.equal(res.provider, 'Byesu');
  });
});

