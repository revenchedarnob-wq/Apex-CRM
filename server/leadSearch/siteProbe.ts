import { tavilyExtract, hasTavilyKey } from '../services/llm.js';
import {
  isBrightDataConfigured,
  isBrightDataCoolingDown,
  scrapeAsMarkdown,
  isBrightDataPro,
  brightDataScrapeAsHtml,
} from '../services/brightdata.js';
import {
  getEnrichmentCacheEntry,
  upsertEnrichmentCacheEntry,
  getNegativeEnrichmentCacheEntry,
  upsertNegativeEnrichmentCacheEntry
} from '../db.js';
import { isFlagEnabled } from './featureFlags.js';
import { isPrivateOrInternalHost } from '../services/privateHosts.js';
export { isPrivateOrInternalHost };
import { Agent, buildConnector } from 'undici';
import dns from 'node:dns';
import type { EnrichmentTarget } from './stages/enrichStage.js';

const ssrfConnector = buildConnector({
  lookup: (hostname, _options, callback) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return (callback as any)(err, addresses);
      const addrs = Array.isArray(addresses) ? addresses : [{ address: (addresses as any)?.address || addresses, family: 4 }];
      for (const addr of addrs) {
        if (addr?.address && isPrivateOrInternalHost(addr.address)) {
          return (callback as any)(
            new Error(`SSRF blocked: ${hostname} resolved to internal/private IP ${addr.address}`),
            [],
          );
        }
      }
      (callback as any)(null, addresses);
    });
  },
});

export const ssrfSafeDispatcher = new Agent({
  connect: (opts: any, cb: any) => {
    const target = opts.hostname || opts.host;
    if (target && isPrivateOrInternalHost(target)) {
      return cb(new Error(`SSRF blocked: ${target} is an internal/private host`), null);
    }
    return ssrfConnector(opts, cb);
  },
});

const GENERIC_SHORT_SLUGS = new Set([
  'apex', 'river', 'peak', 'nova', 'matrix', 'delta', 'echo', 'orbit', 'pulse',
  'alpha', 'summit', 'horizon', 'scale', 'vanguard', 'nexus', 'beacon', 'atlas',
  'forge', 'zenith', 'prism', 'flux', 'vertex', 'shift', 'core', 'spark', 'stride'
]);

const BLOCKED_DOMAINS = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'google.com',
  'www.google.com',
  'facebook.com',
  'www.facebook.com',
  'instagram.com',
  'www.instagram.com',
  'twitter.com',
  'www.twitter.com',
  'x.com',
  'www.x.com',
  'crunchbase.com',
  'www.crunchbase.com',
  'glassdoor.com',
  'www.glassdoor.com',
  'youtube.com',
  'www.youtube.com',
  'github.com',
  'www.github.com',
  'tiktok.com',
  'www.tiktok.com',
  'reddit.com',
  'www.reddit.com',
  't.co',
  'bit.ly'
]);

const PARKED_JUNK_PATTERNS = [
  /domain\s+(?:is\s+)?(?:for\s+sale|available\s+for\s+purchase|parked)/i,
  /buy\s+this\s+domain/i,
  /please\s+enable\s+cookies/i,
  /enable\s+javascript/i,
  /attention\s+required\s*\|\s*cloudflare/i,
  /404\s+not\s+found/i,
  /page\s+not\s+found/i,
  /access\s+denied/i,
  /security\s+checkpoint/i
];

export type DomainProvenance = 'explicit' | 'evidence_url' | 'slug_guess';

export type DerivedDomain = {
  domain: string;
  provenance: DomainProvenance;
};

export type SiteSignals = {
  location?: string;
  headcount?: string;
  services?: string;
  pricingModel?: string;
  caseStudies?: string;
  techStack?: string;
  openRoles?: string;
  sourceUrl?: string;
  provenance?: DomainProvenance;
  rawExcerpt?: string;
};

const clean = (val: unknown) => String(val || '').replace(/\s+/g, ' ').trim();



export function normalizeDomainUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    const host = parsed.hostname.toLowerCase().replace(/^www\./i, '');
    if (!host || BLOCKED_DOMAINS.has(host) || BLOCKED_DOMAINS.has(`www.${host}`)) {
      return null;
    }
    for (const blocked of BLOCKED_DOMAINS) {
      if (host === blocked || host.endsWith(`.${blocked}`)) {
        return null;
      }
    }
    if (isPrivateOrInternalHost(host)) {
      return null;
    }
    // Host must look like a real domain (e.g. contains at least one dot, no spaces)
    if (!host.includes('.') || host.endsWith('.')) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

export function deriveCompanyDomainWithProvenance(lead: Record<string, any>): DerivedDomain | null {
  // 1. Check explicit website fields
  const explicitSite =
    lead.website ||
    lead.companyWebsite ||
    lead.contactDetails?.website ||
    lead.profile?.website ||
    lead.companyAccount?.website;
  const fromExplicit = normalizeDomainUrl(explicitSite);
  if (fromExplicit) return { domain: fromExplicit, provenance: 'explicit' };

  // 2. Scan evidence text and snippets for non-social URLs
  const candidateTexts: string[] = [
    lead.evidence?.evidenceBlock || '',
    ...(Array.isArray(lead.evidence?.snippets)
      ? lead.evidence.snippets.map((s: any) => typeof s === 'string' ? s : s?.text || '')
      : []),
    lead.sourceUrl || ''
  ];

  // G3: evidence_url provenance is untrusted prose -- require the URL host to
  // share a meaningful token with the company name (after stripping
  // TLD/suffixes), otherwise a press link (e.g. techcrunch.com) would be
  // probed as the company's own site.
  const rawCompanyForUrlGuard =
    lead.currentCompany || lead.company || lead.profile?.currentCompany || '';
  const companyTokensForUrlGuard = String(rawCompanyForUrlGuard)
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|corp|corporation|gmbh|co|company|group|holdings|services|solutions|agency|consulting|studio|srl|sas|sl|ag|pty|sdn|bhd|aps)\b/gi, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 4);
  const urlHostSharesCompanyToken = (normalized: string): boolean => {
    if (companyTokensForUrlGuard.length === 0) return false;
    const host = (() => { try { return new URL(normalized).hostname.toLowerCase(); } catch { return ''; } })();
    const hostParts = host.split('.').slice(0, -1).join(' ').split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    const hostJoined = hostParts.join('');
    return companyTokensForUrlGuard.some(tok =>
      hostJoined.includes(tok) || hostParts.some(h => h.includes(tok) || tok.includes(h)));
  };

  const urlRegex = /\bhttps?:\/\/[^\s"'<>()[\]]+/gi;
  for (const text of candidateTexts) {
    const matches = text.match(urlRegex) || [];
    for (const match of matches) {
      const normalized = normalizeDomainUrl(match);
      if (!normalized) continue;
      // G3 identity guard for untrusted evidence prose.
      if (!urlHostSharesCompanyToken(normalized)) continue;
      return { domain: normalized, provenance: 'evidence_url' };
    }
  }

  // 3. Fallback: Slug guess from company name
  const rawCompany = lead.currentCompany || lead.company || lead.profile?.currentCompany;
  if (rawCompany && typeof rawCompany === 'string') {
    const slug = rawCompany
      .toLowerCase()
      .replace(/\b(?:inc|llc|ltd|corp|corporation|gmbh|co|company|group|holdings|services|solutions|agency|consulting)\b/gi, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();

    if (slug.length >= 3 && slug.length <= 32) {
      if (isFlagEnabled.safeSlugProbe() && GENERIC_SHORT_SLUGS.has(slug)) {
        // Do not guess naked .com for short generic brand words
        return null;
      }
      return { domain: `https://${slug}.com`, provenance: 'slug_guess' };
    }
  }

  return null;
}

export function deriveCompanyDomain(lead: Record<string, any>): string | null {
  const derived = deriveCompanyDomainWithProvenance(lead);
  return derived ? derived.domain : null;
}

export function matchesCompanyIdentity(
  companyName: string | undefined,
  markdown: string,
  lead?: Record<string, any>,
  provenance?: DomainProvenance
): boolean {
  if (!companyName || !markdown) return false;
  const cleanedCompany = companyName
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|corp|corporation|gmbh|co|company|group|holdings|services|solutions|agency|consulting|studio|media|technologies|tech)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();

  const tokens = cleanedCompany.split(/\s+/).filter(t => t.length >= 3);
  let baseMatched = false;
  const lowerMarkdown = markdown.toLowerCase();

  if (tokens.length === 0) {
    const bare = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    baseMatched = bare.length >= 3 && lowerMarkdown.includes(bare);
  } else {
    baseMatched = tokens.some(token => {
      const wordRegex = new RegExp(`\\b${token}\\b`, 'i');
      return wordRegex.test(lowerMarkdown);
    });
  }

  if (!baseMatched) return false;

  // When safe slug probe is active and provenance is slug_guess, enforce secondary attribute corroboration
  if (isFlagEnabled.safeSlugProbe() && provenance === 'slug_guess' && lead) {
    const loc = String(
      lead.location || lead.profile?.location || lead.evidence?.evidenceBlock || '',
    ).toLowerCase();
    const locTokens = loc
      .split(/[^a-z0-9]+/)
      .filter(
        t =>
          t.length >= 3 &&
          ![
            'united',
            'states',
            'kingdom',
            'area',
            'link',
            'https',
            'www',
            'linkedin',
            'com',
            'name',
            'company',
            'title',
            'snippet',
          ].includes(t),
      );
    const locMatched = locTokens.length > 0 && locTokens.some(t => lowerMarkdown.includes(t));

    const personName = String(lead.fullName || lead.profile?.fullName || '').toLowerCase();
    const nameTokens = personName.split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    const nameMatched = nameTokens.length >= 2 && nameTokens.every(t => lowerMarkdown.includes(t));

    const ind = String(
      lead.industry || lead.profile?.industry || lead.headline || lead.currentTitle || '',
    ).toLowerCase();
    const indTokens = ind
      .split(/[^a-z0-9]+/)
      .filter(
        t =>
          t.length >= 4 &&
          !['founder', 'owner', 'partner', 'director', 'chief', 'president', 'principal'].includes(t),
      );
    const indMatched = indTokens.length > 0 && indTokens.some(t => lowerMarkdown.includes(t));

    const multiTokenCompanyMatched =
      tokens.length >= 2 &&
      tokens.every(token => new RegExp(`\\b${token}\\b`, 'i').test(lowerMarkdown));

    return locMatched || nameMatched || indMatched || multiTokenCompanyMatched;
  }

  return true;
}

export function parseSiteSignalsFromEvidenceBlock(block?: string): SiteSignals {
  const signals: SiteSignals = {};
  if (!block) return signals;
  const [structuredPart, rawExcerptPart] = block.split(/\r?\n---\r?\n/);
  const lines = (structuredPart || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const locMatch = line.match(/^Location:\s*(.+)$/i);
    if (locMatch?.[1]) signals.location = locMatch[1].trim();
    const teamMatch = line.match(/^Team:\s*(.+)$/i);
    if (teamMatch?.[1]) signals.headcount = teamMatch[1].trim();
    const srvMatch = line.match(/^Services:\s*(.+)$/i);
    if (srvMatch?.[1]) signals.services = srvMatch[1].trim();
  }
  if (!signals.location && !signals.headcount && !signals.services && lines.length > 0) {
    signals.services = lines.join(' | ').slice(0, 380);
  }
  if (rawExcerptPart && rawExcerptPart.trim()) {
    signals.rawExcerpt = rawExcerptPart.trim();
  }
  return signals;
}

export function extractSiteSignals(markdown: string): SiteSignals | null {
  if (!markdown || markdown.length < 180) return null;

  // Sanity check: reject parked/junk/blocked pages
  if (PARKED_JUNK_PATTERNS.some(pattern => pattern.test(markdown))) {
    return null;
  }

  const signals: SiteSignals = {};

  // 1. Location extraction
  const locationMatch = markdown.match(/\b(?:based|located|headquartered|offices?)\s+(?:in|at|across)\s+([A-Za-z0-9 ,.'-]{3,70})/i);
  if (locationMatch?.[1]) {
    const loc = clean(locationMatch[1].split(/[\r\n;.]/)[0]).slice(0, 80);
    if (loc.length >= 3 && !/^(the|a|an|our|their|multiple|various)\b/i.test(loc)) {
      signals.location = loc;
    }
  }

  if (!signals.location) {
    const addressMatch = markdown.match(/\b([A-Z][a-zA-Z\s.-]+,\s*(?:[A-Z]{2,3}|United States|Canada|United Kingdom|Australia|New Zealand|Germany|France|Netherlands)(?:\s+\d{4,5})?)\b/);
    if (addressMatch?.[1]) {
      const loc = clean(addressMatch[1]).slice(0, 80);
      if (loc.length >= 3) {
        signals.location = loc;
      }
    }
  }

  // 2. Headcount extraction
  const headcountMatch =
    markdown.match(/\b(?:team of|we are|we're)\s+([0-9]{1,4})\b/i) ||
    markdown.match(/\b([0-9]{1,4})\+?\s*(?:people|employees|team members|creatives|specialists|engineers|consultants|staff)\b/i);

  if (headcountMatch?.[1]) {
    const count = parseInt(headcountMatch[1], 10);
    if (Number.isFinite(count) && count > 0 && count < 50000) {
      signals.headcount = String(count);
    }
  }

  // 3. Services extraction
  const serviceLines = markdown
    .split(/\r?\n/)
    .map(line => clean(line))
    .filter(line =>
      line.length >= 10 &&
      line.length <= 360 &&
      /\b(automation|integration|workflow|crm|seo|paid media|growth|development|consulting|marketing|revops|design|software|ai|agents?|llm|chatbots?|agency|analytics|data|cloud|digital|transformation|solutions|engineering|lead gen|b2b|custom api|make|zapier|n8n)\b/i.test(line)
    )
    .map(line => line.slice(0, 200))
    .slice(0, 4);

  if (serviceLines.length > 0) {
    signals.services = clean(serviceLines.join(' | ')).slice(0, 380);
  }

  // 4. Pricing / packaging signals
  const pricingMatch = markdown.match(/\b(starts\s+at\s+\$[0-9,]+|\$[0-9,]+\s*\/\s*(?:mo|month|yr|year)|retainer\s+from\s+\$[0-9,]+|pricing\s+tier|enterprise\s+tier|custom\s+pricing|annual\s+billing)\b/i);
  if (pricingMatch?.[0]) {
    signals.pricingModel = clean(pricingMatch[0]).slice(0, 100);
  }

  // 5. Tech stack / partner ecosystem signals
  const techStackMatches = markdown.match(/\b(hubspot|salesforce|stripe|shopify|next\.js|react|aws|gcp|zapier|make\.com|n8n|wordpress|webflow|supabase|snowflake|segment)\b/gi);
  if (techStackMatches && techStackMatches.length > 0) {
    const uniqueTech = Array.from(new Set(techStackMatches.map(t => t.toLowerCase())));
    signals.techStack = uniqueTech.slice(0, 6).join(', ');
  }

  // 6. Case studies / social proof
  const caseStudyMatch = markdown.match(/\b(?:case\s+studies|client\s+stories|trusted\s+by|success\s+stories|featured\s+in|results\s+for)\s*[:\n]\s*([^\n.]{10,120})/i);
  if (caseStudyMatch?.[1]) {
    signals.caseStudies = clean(caseStudyMatch[1]).slice(0, 160);
  }

  // 7. Hiring / open roles
  const hiringMatch = markdown.match(/\b(?:we're\s+hiring|we\s+are\s+hiring|open\s+positions|join\s+our\s+team|current\s+openings)\s*[:\n]?\s*([^\n.]{10,120})/i);
  if (hiringMatch?.[1] || /\b(we're\s+hiring|open\s+roles|careers)\b/i.test(markdown)) {
    signals.openRoles = clean(hiringMatch?.[1] || "Actively hiring").slice(0, 120);
  }

  return Object.keys(signals).length > 0 ? signals : null;
}

export type ProbeTarget = {
  target: EnrichmentTarget;
  domain: string;
  provenance: DomainProvenance;
  companyName?: string;
};

export async function probeCompanySites(
  targets: EnrichmentTarget[],
  options: {
    abortSignal?: AbortSignal;
    onProviderUsage?: (units: number) => void;
  } = {}
): Promise<Map<string, SiteSignals>> {
  const results = new Map<string, SiteSignals>();
  if (!targets.length || !hasTavilyKey()) return results;

  const validTargets: ProbeTarget[] = [];
  for (const target of targets) {
    const derived = deriveCompanyDomainWithProvenance(target.lead);
    if (derived) {
      const companyName = target.lead.currentCompany || target.lead.company || target.lead.profile?.currentCompany;
      validTargets.push({
        target,
        domain: derived.domain,
        provenance: derived.provenance,
        companyName
      });
    }
  }

  if (!validTargets.length) return results;

  // Group unique domains to avoid duplicate probes
  const uniqueDomains = Array.from(new Set(validTargets.map(t => t.domain)));
  const domainProvenanceMap = new Map<string, DomainProvenance>();
  const domainCompanyMap = new Map<string, string | undefined>();
  const domainLeadMap = new Map<string, Record<string, any>>();

  for (const t of validTargets) {
    if (!domainProvenanceMap.has(t.domain)) {
      domainProvenanceMap.set(t.domain, t.provenance);
      domainCompanyMap.set(t.domain, t.companyName);
      domainLeadMap.set(t.domain, t.target.lead);
    }
  }

  // Two-Tier Probing Strategy:
  // Tier 1: Probe cleanRoot for all unique domains first.
  // Tier 2: Only probe /about or /team if the root page yields thin content or lacks key company signals.
  const probeUrlsToDomain = new Map<string, string>();
  const rootUrlsToExtract: string[] = [];

  for (const domain of uniqueDomains) {
    const cleanRoot = domain.replace(/\/$/, '');
    rootUrlsToExtract.push(cleanRoot);
    probeUrlsToDomain.set(cleanRoot, domain);
  }

  const BATCH_SIZE = 20;
  const extractedByDomain = new Map<string, string[]>();

  // --- Tier 1: Extract Root URLs ---
  const rootBatches: string[][] = [];
  for (let i = 0; i < rootUrlsToExtract.length; i += BATCH_SIZE) {
    rootBatches.push(rootUrlsToExtract.slice(i, i + BATCH_SIZE));
  }

  const rootBatchPromises = rootBatches.map(async (batchUrls) => {
    if (options.abortSignal?.aborted) return [];
    options.onProviderUsage?.(batchUrls.length);
    return tavilyExtract(batchUrls, 'company location team size services about us', {
      signal: options.abortSignal,
    });
  });

  const rootBatchSettled = await Promise.allSettled(rootBatchPromises);
  for (const settled of rootBatchSettled) {
    if (settled.status === 'fulfilled' && Array.isArray(settled.value)) {
      for (const res of settled.value) {
        const url = res.url || '';
        const domain = probeUrlsToDomain.get(url) || probeUrlsToDomain.get(url.replace(/\/$/, ''));
        const content = res.rawContent || '';
        if (domain && content) {
          const list = extractedByDomain.get(domain) || [];
          list.push(content);
          extractedByDomain.set(domain, list);
        }
      }
    }
  }

  // --- Tier 2: Conditional Subpath Probing ---
  // Identify domains where root content was extracted but thin (< 400 chars) or missing signals
  const subpathUrlsToExtract: string[] = [];
  for (const domain of uniqueDomains) {
    const contents = extractedByDomain.get(domain) || [];
    const rootText = contents.join('\n\n').trim();
    if (!rootText) {
      // Unreachable / failed root: do not waste calls on subpaths
      continue;
    }
    const hasSignals = Boolean(extractSiteSignals(rootText));
    if (!hasSignals || rootText.length < 400) {
      const cleanRoot = domain.replace(/\/$/, '');
      const subUrls = [`${cleanRoot}/about`, `${cleanRoot}/team`];
      for (const u of subUrls) {
        subpathUrlsToExtract.push(u);
        probeUrlsToDomain.set(u, domain);
      }
    }
  }

  if (subpathUrlsToExtract.length > 0 && !options.abortSignal?.aborted) {
    const subBatches: string[][] = [];
    for (let i = 0; i < subpathUrlsToExtract.length; i += BATCH_SIZE) {
      subBatches.push(subpathUrlsToExtract.slice(i, i + BATCH_SIZE));
    }
    const subBatchPromises = subBatches.map(async (batchUrls) => {
      if (options.abortSignal?.aborted) return [];
      options.onProviderUsage?.(batchUrls.length);
      return tavilyExtract(batchUrls, 'company location team size services about us', {
        signal: options.abortSignal,
      });
    });
    const subBatchSettled = await Promise.allSettled(subBatchPromises);
    for (const settled of subBatchSettled) {
      if (settled.status === 'fulfilled' && Array.isArray(settled.value)) {
        for (const res of settled.value) {
          const url = res.url || '';
          const domain = probeUrlsToDomain.get(url) || probeUrlsToDomain.get(url.replace(/\/$/, ''));
          const content = res.rawContent || '';
          if (domain && content) {
            const list = extractedByDomain.get(domain) || [];
            list.push(content);
            extractedByDomain.set(domain, list);
          }
        }
      }
    }
  }

  const unextractedVerifiedDomains = uniqueDomains.filter(
    (d) =>
      !(extractedByDomain.get(d) || []).length &&
      domainProvenanceMap.get(d) !== 'slug_guess',
  );
  if (
    unextractedVerifiedDomains.length > 0 &&
    isBrightDataConfigured() &&
    !isBrightDataCoolingDown()
  ) {
    const bdPromises = unextractedVerifiedDomains.slice(0, 5).map(async (domain) => {
      if (options.abortSignal?.aborted) return;
      try {
        let content: string | null = null;
        if (isBrightDataPro()) {
          content = await brightDataScrapeAsHtml(domain, 15000);
        }
        if (!content) {
          content = await scrapeAsMarkdown(domain, 12000, options.abortSignal);
        }
        if (content && content.trim().length > 100) {
          extractedByDomain.set(domain, [content]);
        }
      } catch {
        // Safe skip
      }
    });
    await Promise.allSettled(bdPromises);
  }

  const unresolvedSlugDomains: string[] = [];
  for (const domain of uniqueDomains) {
    const contents = extractedByDomain.get(domain) || [];
    const combinedMarkdown = contents.join('\n\n');
    const provenance = domainProvenanceMap.get(domain) || 'slug_guess';
    const companyName = domainCompanyMap.get(domain);
    const lead = domainLeadMap.get(domain);

    // Hardening (G3): slug_guess AND evidence_url domains require company
    // token match in page content. explicit (website field) stays trusted.
    if ((provenance === 'slug_guess' || provenance === 'evidence_url') &&
        !matchesCompanyIdentity(companyName, combinedMarkdown, lead, provenance)) {
      if (provenance === 'slug_guess') unresolvedSlugDomains.push(domain);
      continue;
    }

    const signals = extractSiteSignals(combinedMarkdown);
    if (signals) {
      signals.sourceUrl = domain;
      signals.provenance = provenance;
      signals.rawExcerpt = combinedMarkdown
        ? combinedMarkdown.slice(0, 1200).replace(/\s+/g, ' ').trim()
        : undefined;
      results.set(domain, signals);
    } else if (provenance === 'slug_guess') {
      unresolvedSlugDomains.push(domain);
    }
  }

  // Tier 3: Fast batch probe of alternate regional/tech TLDs (.com.au, .ai, .io, .co) for unresolved slug_guess domains
  if (unresolvedSlugDomains.length > 0 && !options.abortSignal?.aborted) {
    const altUrlToOriginalDomain = new Map<string, string>();
    const altUrlsToExtract: string[] = [];

    for (const domain of unresolvedSlugDomains) {
      if (altUrlsToExtract.length >= BATCH_SIZE) break;
      const slugMatch = domain.match(/^https?:\/\/([a-z0-9-]+)\.com$/i);
      if (!slugMatch?.[1]) continue;
      const slug = slugMatch[1];
      const lead = domainLeadMap.get(domain);
      const contextText = [
        lead?.location,
        lead?.profile?.location,
        lead?.headline,
        lead?.currentTitle,
        lead?.currentCompany,
        lead?.evidence?.evidenceBlock,
      ]
        .filter(Boolean)
        .join(' ');
      const isAuContext = /\b(australia|australian|sydney|melbourne|brisbane|perth|adelaide|canberra|gold coast|nsw|vic|qld)\b/i.test(
        contextText,
      );
      const isUkContext = /\b(united kingdom|\buk\b|london|manchester|birmingham|edinburgh|england|britain)\b/i.test(
        contextText,
      );
      const isAiTech = /\b(ai|artificial intelligence|automation|agents?|llm|software|tech|digital|data|cloud)\b/i.test(
        contextText,
      );

      const candidateTlds: string[] = [];
      if (isAuContext) candidateTlds.push('com.au');
      else if (isUkContext) candidateTlds.push('co.uk');
      if (isAiTech) candidateTlds.push('ai', 'io');
      else candidateTlds.push('co', 'io');

      for (const tld of candidateTlds.slice(0, 2)) {
        if (altUrlsToExtract.length >= BATCH_SIZE) break;
        const altUrl = `https://${slug}.${tld}`;
        altUrlsToExtract.push(altUrl);
        altUrlToOriginalDomain.set(altUrl, domain);
      }
    }

    if (altUrlsToExtract.length > 0) {
      try {
        options.onProviderUsage?.(altUrlsToExtract.length);
        const altExtracted = await tavilyExtract(
          altUrlsToExtract,
          'company location team size services about us',
          {
            signal: options.abortSignal,
            timeout: 8,
          },
        );
        if (Array.isArray(altExtracted)) {
          for (const res of altExtracted) {
            const rawUrl = (res.url || '').replace(/\/$/, '');
            const originalDomain =
              altUrlToOriginalDomain.get(res.url || '') ||
              altUrlToOriginalDomain.get(rawUrl);
            const content = res.rawContent || '';
            if (!originalDomain || !content || results.has(originalDomain)) continue;
            const companyName = domainCompanyMap.get(originalDomain);
            const lead = domainLeadMap.get(originalDomain);
            if (!matchesCompanyIdentity(companyName, content, lead, 'slug_guess')) {
              continue;
            }
            const signals = extractSiteSignals(content);
            if (signals) {
              signals.sourceUrl = rawUrl || originalDomain;
              signals.provenance = 'slug_guess';
              signals.rawExcerpt = content
                .slice(0, 1200)
                .replace(/\s+/g, ' ')
                .trim();
              results.set(originalDomain, signals);
            }
          }
        }
      } catch {
        // Safe skip on alternate TLD batch error
      }
    }
  }

  return results;
}

export function applySiteProbeSignals(
  target: EnrichmentTarget,
  signals: SiteSignals,
  sourceUrl: string,
  refreshLeadEvidence?: (target: EnrichmentTarget) => void
): string[] {
  const lead = target.lead;
  lead.profile = lead.profile || {};
  lead.companyAccount = lead.companyAccount || {};

  // 1. Populate empty location (G2: tag provenance so the judge can
  // distinguish person-stated location from company-HQ-derived location)
  if (!lead.location && !lead.profile.location && signals.location) {
    lead.location = signals.location;
    lead.profile.location = signals.location;
    lead._locationProvenance = 'company_site';
    lead.profile._locationProvenance = 'company_site';
  }

  // 2. Populate empty headcount / company size
  if (!lead.companySizeEst && !lead.profile.companySizeEst && signals.headcount) {
    lead.companySizeEst = signals.headcount;
    lead.profile.companySizeEst = signals.headcount;
  }
  if (!lead.companyAccount.employeeCount && signals.headcount) {
    lead.companyAccount.employeeCount = signals.headcount;
  }

  // 3. Populate empty company description / services
  if (!lead.companyAccount.description && signals.services) {
    lead.companyAccount.description = signals.services;
  }

  // 4. Append site evidence line with provenance tag
  const evidenceLines: string[] = [];
  if (signals.location) evidenceLines.push(`Location: ${signals.location}`);
  if (signals.headcount) evidenceLines.push(`Team: ${signals.headcount}`);
  if (signals.services) evidenceLines.push(`Services: ${signals.services}`);

  if (evidenceLines.length > 0 || signals.rawExcerpt) {
    const provenanceTag = signals.provenance === 'slug_guess'
      ? 'name-match'
      : signals.provenance === 'explicit'
        ? 'verified-site'
        : 'extracted-url';

    const displayUrl = signals.sourceUrl || sourceUrl;
    const summaryPart = evidenceLines.length > 0 ? ` ${evidenceLines.join(' | ')}` : '';
    const excerptPart = signals.rawExcerpt ? `\n${signals.rawExcerpt}` : '';
    const siteEvidence = `[COMPANY SITE (${provenanceTag}): ${displayUrl}]${summaryPart}${excerptPart}`;
    if (target.evidenceMeta) {
      target.evidenceMeta.evidenceBlock = [target.evidenceMeta.evidenceBlock, siteEvidence].filter(Boolean).join('\n');
    }
    if (lead.evidence) {
      lead.evidence.evidenceBlock = [lead.evidence.evidenceBlock, siteEvidence].filter(Boolean).join('\n');
      lead.evidence.snippets = lead.evidence.snippets || [];
      lead.evidence.snippets.push(siteEvidence);
    }
  }

  // 5. Recompute verification and scoring if callback provided
  if (refreshLeadEvidence) {
    refreshLeadEvidence(target);
  }

  return evidenceLines;
}

export function applySiteProbe(
  target: EnrichmentTarget,
  signals: SiteSignals,
  sourceUrl: string,
  refreshLeadEvidence?: (target: EnrichmentTarget) => void
) {
  const lead = target.lead;
  const evidenceLines = applySiteProbeSignals(target, signals, sourceUrl, refreshLeadEvidence);

  // 6. Record positive cache entry (with both structured signals AND raw prose excerpt)
  if (evidenceLines.length > 0) {
    try {
      let host = sourceUrl;
      try {
        host = new URL(sourceUrl.startsWith('http') ? sourceUrl : `https://${sourceUrl}`).hostname.replace(/^www\./, '').toLowerCase();
      } catch {}
      const structuredLines = evidenceLines.join('\n');
      const rawExcerpt = signals.rawExcerpt
        ? signals.rawExcerpt.slice(0, 1200).replace(/\s+/g, ' ').trim()
        : '';
      const fullEvidenceBlock = rawExcerpt
        ? `${structuredLines}\n---\n${rawExcerpt}`
        : structuredLines;
      upsertEnrichmentCacheEntry({
        normalizedUrl: host,
        companyName: lead.currentCompany || lead.company,
        evidenceBlock: fullEvidenceBlock,
        scrapeQuality: signals.location && signals.services ? 'good' : 'partial',
        sourceProvider: 'site_probe'
      }, 7);
    } catch {
      // ignore cache write errors
    }
  }
}

export async function groundCandidateWithSiteProbe(
  lead: Record<string, any>,
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string | null> {
  const derived = deriveCompanyDomainWithProvenance(lead);
  if (!derived || !derived.domain) return null;
  const rawTarget = derived.domain.replace(/\/$/, '').toLowerCase();
  const targetUrl = /^https?:\/\//i.test(rawTarget) ? rawTarget : `https://${rawTarget}`;
  let host = "";
  try {
    host = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
  if (!host || isPrivateOrInternalHost(host)) return null;

  // Check enrichment cache first
  try {
    const cached = getEnrichmentCacheEntry({ normalizedUrl: host });
    if (cached?.evidenceBlock) {
      const siteEvidence = `[COMPANY SITE (${derived.provenance}): ${host}] ${clean(cached.evidenceBlock).slice(0, 300)}`;
      lead.evidence = lead.evidence || {};
      lead.evidence.snippets = lead.evidence.snippets || [];
      if (!lead.evidence.snippets.some((s: string) => s.includes(host))) {
        lead.evidence.snippets.push(siteEvidence);
        lead.evidence.evidenceBlock = [lead.evidence.evidenceBlock, siteEvidence].filter(Boolean).join('\n');
      }
      return siteEvidence;
    }
    const negative = getNegativeEnrichmentCacheEntry({ normalizedUrl: host }, new Date(), 'site_probe');
    if (negative) return null;
  } catch {}

  // Fast non-LLM fetch of root page
  try {
    const timeout = options.timeoutMs || 2500;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const onAbort = () => controller.abort();
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    let html = '';
    try {
      // Redirects are followed MANUALLY and re-validated at every hop. With
      // `redirect: 'follow'` the SSRF guard above only ever saw the first URL, so any
      // public host could 302 the probe to http://169.254.169.254/ or a loopback address
      // and the fetch would follow it. `brightdata.scrapeAsMarkdown` already implements
      // this pattern; this brings the site probe in line with it.
      let currentUrl = targetUrl;
      for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
        const resp = await fetch(currentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: controller.signal,
          redirect: 'manual',
          dispatcher: ssrfSafeDispatcher,
        } as any);

        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get('location');
          if (!location) break;
          let nextUrl: string;
          try {
            nextUrl = new URL(location, currentUrl).toString();
          } catch {
            break;
          }
          const nextHost = new URL(nextUrl).hostname.replace(/^www\./, '').toLowerCase();
          if (!nextHost || isPrivateOrInternalHost(nextHost)) return null;
          currentUrl = nextUrl;
          continue;
        }

        if (resp.ok) {
          const text = await resp.text();
          html = text.slice(0, 15000);
        } else if (resp.status === 404 || resp.status === 410) {
          try {
            upsertNegativeEnrichmentCacheEntry({
              normalizedUrl: host,
              companyName: lead.currentCompany || lead.company,
              evidenceBlock: 'probe_not_found',
              scrapeQuality: 'bad',
              sourceProvider: 'site_probe',
            }, 48);
          } catch {}
          return null;
        }
        break;
      }
    } finally {
      clearTimeout(timeoutId);
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', onAbort);
      }
    }

    if (!html) return null;

    const metaDescMatch =
      html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i) ||
      html.match(/<meta\s+[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const description = metaDescMatch?.[1] ? clean(metaDescMatch[1]).slice(0, 250) : '';
    const title = titleMatch?.[1] ? clean(titleMatch[1]).slice(0, 150) : '';

    const evidenceContent = description || title;
    if (!evidenceContent || evidenceContent.length < 15) return null;

    const provenanceTag = derived.provenance === 'slug_guess' ? 'name-match' : 'verified-site';
    const siteEvidence = `[COMPANY SITE (${provenanceTag}): ${host}] ${evidenceContent}`;

    lead.evidence = lead.evidence || {};
    lead.evidence.snippets = lead.evidence.snippets || [];
    if (!lead.evidence.snippets.some((s: string) => s.includes(host))) {
      lead.evidence.snippets.push(siteEvidence);
      lead.evidence.evidenceBlock = [lead.evidence.evidenceBlock, siteEvidence].filter(Boolean).join('\n');
    }

    try {
      upsertEnrichmentCacheEntry({
        normalizedUrl: host,
        companyName: lead.currentCompany || lead.company,
        evidenceBlock: evidenceContent,
        scrapeQuality: description ? 'good' : 'partial',
        sourceProvider: 'site_probe',
      }, 7);
    } catch {}

    return siteEvidence;
  } catch (err: any) {
    try {
      const isDefinitiveFailure =
        err?.code === 'ENOTFOUND' ||
        /not found|does not exist/i.test(err?.message || '');
      if (isDefinitiveFailure) {
        upsertNegativeEnrichmentCacheEntry({
          normalizedUrl: host,
          companyName: lead.currentCompany || lead.company,
          evidenceBlock: 'probe_not_found',
          scrapeQuality: 'bad',
          sourceProvider: 'site_probe',
        }, 48);
      }
    } catch {}
    return null;
  }
}

