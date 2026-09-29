import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DASHBOARD_NAV_ITEMS,
  getHashForTab,
  getTabFromHash,
} from '../src/lib/navigation';
import {
  getPipelineStageDomId,
  NEXT_PIPELINE_STAGE,
  PIPELINE_STAGE_IDS,
  PIPELINE_STAGES,
  PREVIOUS_PIPELINE_STAGE,
} from '../src/lib/pipeline';
import {
  DEFAULT_MANUAL_INDUSTRY,
  isDiscoveryProviderConfigured,
  MANUAL_PROSPECT_INDUSTRIES,
  PROSPECTS_PAGE_SIZE,
} from '../src/lib/ui';
import {
  NEXT_ACTION_OPTIONS,
  REVIEW_STATUS_OPTIONS,
} from '../src/lib/prospectWorkflow';

function collectTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTsxFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [entryPath] : [];
  });
}

test('dashboard navigation hashes round-trip without duplicate labels or routes', () => {
  assert.equal(new Set(DASHBOARD_NAV_ITEMS.map((item) => item.id)).size, DASHBOARD_NAV_ITEMS.length);
  assert.equal(new Set(DASHBOARD_NAV_ITEMS.map((item) => item.hash)).size, DASHBOARD_NAV_ITEMS.length);
  assert.equal(new Set(DASHBOARD_NAV_ITEMS.map((item) => item.label)).size, DASHBOARD_NAV_ITEMS.length);

  for (const item of DASHBOARD_NAV_ITEMS) {
    assert.equal(getTabFromHash(getHashForTab(item.id)), item.id);
  }

  assert.equal(getTabFromHash('#workspace'), 'workspace');
  assert.equal(getTabFromHash('#inventory'), 'inventory');
  assert.equal(getTabFromHash('#unknown'), 'overview');
});

test('pipeline metadata is complete, unique, and internally consistent', () => {
  const expectedStages = [
    'SCRAPED',
    'ENRICHED',
    'SEQUENCE ACTIVE',
    'REPLIED',
    'MEETING BOOKED',
    'NEGOTIATING',
    'CONVERTED',
    'NURTURE',
    'LOST',
  ];

  assert.deepEqual([...PIPELINE_STAGE_IDS].sort(), [...expectedStages].sort());
  assert.equal(new Set(PIPELINE_STAGE_IDS).size, PIPELINE_STAGES.length);

  for (const [source, destination] of Object.entries(NEXT_PIPELINE_STAGE)) {
    assert.ok(PIPELINE_STAGE_IDS.includes(source as (typeof PIPELINE_STAGE_IDS)[number]));
    assert.ok(PIPELINE_STAGE_IDS.includes(destination));
  }

  assert.deepEqual(PREVIOUS_PIPELINE_STAGE, {
    ENRICHED: 'SCRAPED',
    'SEQUENCE ACTIVE': 'ENRICHED',
    REPLIED: 'SEQUENCE ACTIVE',
    'MEETING BOOKED': 'REPLIED',
    NEGOTIATING: 'MEETING BOOKED',
    CONVERTED: 'NEGOTIATING',
  });
  assert.equal(PREVIOUS_PIPELINE_STAGE.NURTURE, undefined);
  assert.equal(PREVIOUS_PIPELINE_STAGE.LOST, undefined);

  const stageDomIds = PIPELINE_STAGE_IDS.map(getPipelineStageDomId);
  assert.equal(new Set(stageDomIds).size, PIPELINE_STAGE_IDS.length);
  assert.ok(stageDomIds.every((id) => /^pipeline-stage-[a-z0-9-]+$/.test(id)));
});

test('prospect UI defaults remain valid and inventory stays at 100 rows per page', () => {
  assert.equal(PROSPECTS_PAGE_SIZE, 100);
  assert.ok(MANUAL_PROSPECT_INDUSTRIES.includes(DEFAULT_MANUAL_INDUSTRY));
  assert.deepEqual(REVIEW_STATUS_OPTIONS.map(option => option.value), ['UNREVIEWED', 'KEEP', 'MAYBE', 'REJECT']);
  assert.deepEqual(NEXT_ACTION_OPTIONS.map(option => option.value), ['NONE', 'OPEN_LINKEDIN', 'OPEN_FACEBOOK', 'RESEARCH', 'CONNECT', 'MESSAGE', 'CALL', 'EMAIL']);
});

test('prospect UI keeps email while exposing no dedicated discovery controls', () => {
  const leadTable = readFileSync(path.resolve('src/components/LeadTable.tsx'), 'utf8');
  const scrapeWorkspace = readFileSync(path.resolve('src/components/ScrapeWorkspace.tsx'), 'utf8');
  const types = readFileSync(path.resolve('src/types.ts'), 'utf8');
  const combined = `${leadTable}\n${scrapeWorkspace}\n${types}`;
  assert.doesNotMatch(combined, /find-email|email-discovery|forceEmailDiscovery|forceProfileScrape|lastReviewedAt|followUpAt/);
  assert.match(types, /email\?: string/);
  assert.match(leadTable, /Review status/);
  assert.match(leadTable, /Next action/);
});

test('discovery readiness requires both an LLM and a retrieval provider', () => {
  assert.equal(isDiscoveryProviderConfigured({ hasKey: true }), false);
  assert.equal(isDiscoveryProviderConfigured({ hasTavilyKey: true }), false);
  assert.equal(isDiscoveryProviderConfigured({ hasKey: true, hasTavilyKey: true }), true);
  assert.equal(
    isDiscoveryProviderConfigured({ hasKey: true, brightData: { configured: true } }),
    true,
  );
  assert.equal(
    isDiscoveryProviderConfigured({
      hasKey: true,
      providerCapabilities: { brightData: { configured: true } },
    }),
    true,
  );
});

test('UI source avoids unreadable type sizes and undefined project color scales', () => {
  const violations: string[] = [];
  const tinyTextPattern = /text-\[(?:[0-9]|1[01])px\]/g;
  const undefinedColorPattern = /\b(?:indigo|rose|amber|blue)-(?:350|450|505|550|650|850)\b/g;

  for (const file of collectTsxFiles(path.resolve('src'))) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of [tinyTextPattern, undefinedColorPattern]) {
      pattern.lastIndex = 0;
      const matches = [...source.matchAll(pattern)];
      if (matches.length > 0) {
        violations.push(`${path.relative(process.cwd(), file)}: ${matches.map((match) => match[0]).join(', ')}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

import { miningTraceStore } from '../src/lib/traceStore.js';

test('miningTraceStore manages session live state and subscriber notifications', () => {
  const sessionId = `test-session-${Date.now()}`;

  const initial = miningTraceStore.getState(sessionId);
  assert.equal(initial.sessionId, sessionId);
  assert.equal(initial.status, 'idle');
  assert.deepEqual(initial.logs, []);
  assert.deepEqual(initial.traceEvents, []);

  let notifyCalled = false;
  const unsubscribe = miningTraceStore.subscribe(() => {
    notifyCalled = true;
  });

  const disconnect = miningTraceStore.connect(sessionId);
  assert.ok(typeof disconnect === 'function');
  assert.ok(notifyCalled, 'Subscriber should be notified on connect state change');

  unsubscribe();
  miningTraceStore.resetSession(sessionId);
});

import { formatDuration } from '../src/components/TraceTerminal.js';

test('formatDuration accurately handles millisecond, second, and minute ranges', () => {
  assert.equal(formatDuration(undefined), '0s');
  assert.equal(formatDuration(-10), '0s');
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(250), '250ms');
  assert.equal(formatDuration(1200), '1.2s');
  assert.equal(formatDuration(5000), '5.0s');
  assert.equal(formatDuration(59900), '59.9s');
  assert.equal(formatDuration(60000), '1m 0s');
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(formatDuration(130000), '2m 10s');
});

test('TraceTerminal exports duration metrics card and live session telemetry', () => {
  const terminalSource = readFileSync(path.resolve('src/components/TraceTerminal.tsx'), 'utf8');
  assert.match(terminalSource, /useSessionDuration/);
  assert.match(terminalSource, /formatDuration/);
  assert.match(terminalSource, /<span>Duration<\/span>/);
  assert.match(terminalSource, /Running:\s*\$\{formatDuration/);
});

test('App.tsx wraps all tabs with TabErrorBoundary', () => {
  const appSource = readFileSync(path.resolve('src/App.tsx'), 'utf8');
  assert.match(appSource, /import TabErrorBoundary from '\.\/components\/TabErrorBoundary'/);
  assert.match(appSource, /<TabErrorBoundary tabName="Discover prospects">/);
  assert.match(appSource, /<TabErrorBoundary tabName="CRM overview">/);
  assert.match(appSource, /<TabErrorBoundary tabName="Pipeline">/);
  assert.match(appSource, /<TabErrorBoundary tabName="Prospect inventory">/);
  assert.match(appSource, /<TabErrorBoundary tabName="Outreach">/);
  assert.match(appSource, /<TabErrorBoundary tabName="Apex Copilot">/);
});

test('ScrapeWorkspace.tsx does not cancel backend mining sessions on unmount', () => {
  const scrapeSource = readFileSync(path.resolve('src/components/ScrapeWorkspace.tsx'), 'utf8');
  // Unmount effect must NOT contain fetch(/cancel) or controller aborts
  const unmountEffectMatch = scrapeSource.match(/useEffect\(\(\) => \(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(unmountEffectMatch, 'Unmount effect must exist');
  assert.doesNotMatch(unmountEffectMatch[1], /\/cancel/);
  assert.doesNotMatch(unmountEffectMatch[1], /activeDiscovery.*abort\(\)/);
  assert.match(unmountEffectMatch[1], /miningTraceStore\.disconnect/);
});

test('CrmPipeline defensively guards invalid lead stages with SCRAPED fallback', () => {
  const pipelineSource = readFileSync(path.resolve('src/components/CrmPipeline.tsx'), 'utf8');
  assert.match(pipelineSource, /grouped\[lead\.stage\]\s*\?\?\s*grouped\['SCRAPED'\]/);
});

test('CrmPipeline preserves search query substring matching', () => {
  const pipelineSource = readFileSync(path.resolve('src/components/CrmPipeline.tsx'), 'utf8');
  assert.match(
    pipelineSource,
    /\.some\(\(value\)\s*=>\s*value\?\.toLocaleLowerCase\(\)\.includes\(query\)\)/,
  );
});

test('TabErrorBoundary provides resetKey remount and retry button', () => {
  const boundarySource = readFileSync(path.resolve('src/components/TabErrorBoundary.tsx'), 'utf8');
  assert.match(boundarySource, /resetKey/);
  assert.match(boundarySource, /Retry Tab/);
});

test('traceStore exposes frozen DEFAULT_MINING_STATE', () => {
  const traceStoreSource = readFileSync(path.resolve('src/lib/traceStore.ts'), 'utf8');
  assert.match(traceStoreSource, /DEFAULT_MINING_STATE:\s*MiningSessionLiveState\s*=\s*Object\.freeze/);
});

test('ScrapeWorkspace.tsx guarantees completion UI updates are not bypassed by settled flag', () => {
  const scrapeSource = readFileSync(path.resolve('src/components/ScrapeWorkspace.tsx'), 'utf8');
  
  // Ensure cleanupDiscoveryUi is called in finally, not before rehydrateLeads / updateTaskStatus
  assert.match(scrapeSource, /try\s*\{[\s\S]*?await\s+rehydrateLeads[\s\S]*?updateTaskStatus[\s\S]*?\}\s*finally\s*\{\s*cleanupDiscoveryUi\(\)/);
  
  // Ensure updateTaskStatus has fallback logic for active processing tasks
  assert.match(scrapeSource, /findIndex\(t => t\.status === 'processing'\)/);
  
  // Ensure checkActiveSession adds task to Recent Activity
  assert.match(scrapeSource, /const\s+taskId\s*=\s*handleTaskAdd\('search',\s*taskQuery\);/);
});



