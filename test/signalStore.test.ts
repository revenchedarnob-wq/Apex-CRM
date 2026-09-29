import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalStore, companiesMatch, normalizeCompanyName } from '../server/leadSearch/signalStore.js';
import {
  extractCompanyHintDeterministic,
  extractCompanyHintFromProfile,
  isSignalObservation,
  type FusedObservation
} from '../server/leadSearch/observations.js';

const observation = (overrides: Partial<FusedObservation>): FusedObservation => ({
  identityKey: 'url:example.com',
  title: '',
  url: 'https://example.com',
  content: '',
  provider: 'tavily',
  query: 'test query',
  round: 1,
  sourceCount: 1,
  sourceProviders: ['tavily'],
  sourceQueries: ['test query'],
  lanes: [],
  corroborated: false,
  raw: {},
  ...overrides
});

test('normalizeCompanyName strips only trailing legal suffixes', () => {
  assert.equal(normalizeCompanyName('TechFlow AI, LLC'), 'techflow ai');
  assert.equal(normalizeCompanyName('Apex Solutions Corp.'), 'apex solutions');
  assert.equal(normalizeCompanyName('Vanguard Consulting Group'), 'vanguard consulting');
});

test('companiesMatch recognizes a distinctive brand without generic collisions', () => {
  assert.equal(companiesMatch('TechFlow AI', 'TechFlow'), true);
  assert.equal(companiesMatch('TechFlow LLC', 'TechFlow AI'), true);
  assert.equal(companiesMatch('Tech Flow LLC', 'TechFlow'), true);
  assert.equal(companiesMatch('Apex Solutions', 'Apex Growth'), false);
  assert.equal(companiesMatch('Digital Growth Agency', 'Digital Automation Studio'), false);
  assert.equal(companiesMatch('TechFlow AI', 'John Doe'), false);
  assert.equal(companiesMatch('Acme Digital', 'Beta Corp'), false);
  assert.equal(companiesMatch('', 'TechFlow'), false);
});

test('SignalStore deduplicates and retrieves signal blocks by company name', () => {
  const store = new SignalStore();
  const signal = {
    companyName: 'TechFlow AI',
    text: 'Hiring n8n developer for client projects',
    url: 'https://techflow.io/careers/n8n',
    query: 'n8n developer hiring',
    lane: 'signal',
    round: 1,
    provider: 'brightdata' as const
  };
  store.add(signal);
  store.add(signal);

  assert.equal(store.size, 1);
  const matched = store.getForCandidate('TechFlow Studio');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].text, 'Hiring n8n developer for client projects');

  const unmatched = store.getForCandidate('Unrelated Agency');
  assert.equal(unmatched.length, 0);
});

test('isSignalObservation requires an explicit signal lane', () => {
  const linkedinObs = observation({
    identityKey: 'linkedin:johndoe',
    title: 'John Doe - Founder',
    url: 'https://www.linkedin.com/in/johndoe',
    content: 'Founder at TechFlow AI',
    provider: 'tavily',
    query: 'founders',
    round: 1,
    sourceCount: 1,
    sourceProviders: ['tavily'],
    sourceQueries: ['founders'],
    lanes: ['person'],
  });

  const signalObs = observation({
    identityKey: 'url:techflow.io/careers',
    title: 'Hiring n8n Automation Engineer | TechFlow AI',
    url: 'https://techflow.io/careers',
    content: 'TechFlow AI is seeking an n8n automation contractor...',
    provider: 'brightdata',
    query: 'n8n developer hiring',
    round: 1,
    sourceCount: 1,
    sourceProviders: ['brightdata'],
    sourceQueries: ['n8n developer hiring'],
    lanes: ['signal'],
  });
  const accountObs = observation({
    identityKey: 'url:techflow.io/about',
    title: 'About TechFlow AI',
    url: 'https://techflow.io/about',
    content: 'TechFlow AI builds automation systems for external clients.',
    lane: 'account',
    lanes: ['account']
  });

  assert.equal(isSignalObservation(linkedinObs), false);
  assert.equal(isSignalObservation(signalObs), true);
  assert.equal(isSignalObservation(accountObs), false);
});

test('extractCompanyHintDeterministic extracts company from title, hosted path, or domain', () => {
  const obsTitle = observation({
    identityKey: 'url:lever.co/techflow',
    title: 'n8n Developer Job | TechFlow AI',
    url: 'https://jobs.lever.co/techflow/123',
    content: 'Looking for automation developer',
    provider: 'brightdata',
    query: 'n8n developer',
    round: 1,
    sourceCount: 1,
    sourceProviders: ['brightdata'],
    sourceQueries: ['n8n developer'],
    lanes: ['signal'],
  });

  assert.equal(extractCompanyHintDeterministic(obsTitle), 'TechFlow AI');

  const obsHostedPath = observation({
    identityKey: 'url:greenhouse.io/novalabs',
    title: 'Automation Contractor Wanted',
    url: 'https://boards.greenhouse.io/novalabs/jobs/123',
    content: 'We need a Make.com specialist for client delivery.',
    lane: 'signal',
    lanes: ['signal']
  });
  assert.equal(extractCompanyHintDeterministic(obsHostedPath), 'novalabs');

  const obsDomain = observation({
    identityKey: 'url:apexautomation.io/jobs',
    title: 'Automation Contractor Wanted',
    url: 'https://jobs.apexautomation.co.uk/openings/123',
    content: 'We need Make.com specialist',
    provider: 'brightdata',
    query: 'make specialist',
    round: 1,
    sourceCount: 1,
    sourceProviders: ['brightdata'],
    sourceQueries: ['make specialist'],
    lanes: ['signal'],
  });

  assert.equal(extractCompanyHintDeterministic(obsDomain), 'apexautomation');
});

test('extractCompanyHintFromProfile uses structured data, not the LinkedIn header layout', () => {
  const structured = observation({
    url: 'https://www.linkedin.com/in/johndoe',
    raw: { currentCompany: 'TechFlow AI' }
  });
  assert.equal(extractCompanyHintFromProfile(structured), 'TechFlow AI');

  const header = observation({
    url: 'https://www.linkedin.com/in/janedoe',
    content: '# Jane Doe\nNova Automation Partners\nLondon, England, United Kingdom\n500 connections'
  });
  // The second header line is usually the headline, so it is no longer read as the company.
  assert.equal(extractCompanyHintFromProfile(header), '');
});

test('extracted currentCompany attaches the correct open-web signal', () => {
  const store = new SignalStore();
  store.add({
    companyName: 'TechFlow AI',
    text: 'Hiring an n8n developer to clear a client delivery backlog.',
    url: 'https://techflow.ai/careers/n8n',
    query: 'client delivery backlog n8n',
    lane: 'signal',
    round: 1,
    provider: 'tavily'
  });
  store.add({
    companyName: 'Apex Solutions',
    text: 'Expanding the delivery team.',
    url: 'https://apex.example/jobs',
    query: 'delivery hiring',
    lane: 'signal',
    round: 1,
    provider: 'brightdata'
  });

  const extractedLead = { fullName: 'Jane Doe', currentCompany: 'TechFlow Studio' };
  const match = store.getForCandidates([extractedLead.currentCompany, 'Fallback Company']);

  assert.equal(match.companyName, 'TechFlow Studio');
  assert.equal(match.blocks.length, 1);
  assert.match(match.blocks[0].text, /client delivery backlog/);
  assert.equal(store.getForCandidate('Apex Growth').length, 0);
});

test('Fix 5E: harvestSignalsFromSearchItems harvests company signals and persists discovered companies in a batch transaction', async () => {
  const { harvestSignalsFromSearchItems } = await import('../server/leadSearch/signalStore.js');
  const { readDiscoveredCompanyNames } = await import('../server/db.js');
  const store = new SignalStore();
  harvestSignalsFromSearchItems(
    [
      {
        companyName: 'OrbitOps AI',
        title: 'Hiring Senior Automation Architect | OrbitOps AI',
        url: 'https://orbitops.ai/careers',
        content: 'Building n8n and custom LLM pipelines for enterprise clients.',
        query: 'OrbitOps AI hiring',
      },
      {
        title: 'AI Workflow Engineer | QuantumFlow Studio',
        url: 'https://jobs.lever.co/quantumflow/456',
        content: 'Seeking an AI workflow engineer to scale client delivery.',
        query: 'AI workflow engineer lever',
      },
    ],
    1,
    store,
  );
  assert.equal(store.size, 2);
  const names = store.getUniqueCompanyNames();
  assert.ok(names.includes('OrbitOps AI'));
  const persisted = readDiscoveredCompanyNames(50);
  assert.ok(persisted.includes('OrbitOps AI'));
});
