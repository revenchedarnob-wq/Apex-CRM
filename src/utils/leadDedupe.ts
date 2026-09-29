import type { LinkedInProfile } from '../types';

export const normalizeDedupeValue = (value?: string) =>
  (value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .trim();

export function unwrapRedirectUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let current = rawUrl.trim();

  if (current.startsWith('/goto?') || current.startsWith('/url?')) {
    current = `https://brightdata.com${current}`;
  }

  for (let iter = 0; iter < 3; iter++) {
    const redirectParamMatch =
      current.match(/[?&](?:url|q|dest|target|redirect_to|redirect_url)=([^&]+)/i) ||
      current.match(/\/goto\?url=([^&]+)/i);

    if (redirectParamMatch && redirectParamMatch[1]) {
      try {
        const decoded = decodeURIComponent(redirectParamMatch[1]);
        if (decoded && (decoded.startsWith('http') || decoded.includes('linkedin.com') || decoded.startsWith('/'))) {
          current = decoded.startsWith('/') ? `https://brightdata.com${decoded}` : decoded;
          continue;
        }
      } catch {}
    }

    if (current.includes('%2F')) {
      try {
        const decoded = decodeURIComponent(current);
        if (/linkedin\.com/i.test(decoded)) {
          const match = decoded.match(/(https?:\/\/[^\s"'<>)]*linkedin\.com[^\s"'<>)]*)/i);
          if (match && match[1]) {
            current = match[1];
            continue;
          }
        }
      } catch {}
    }

    break;
  }

  return current;
}

const RESERVED_LINKEDIN_PATHS = new Set([
  'feed', 'posts', 'pulse', 'in', 'jobs', 'company', 'school', 'learning',
  'groups', 'events', 'login', 'signup', 'help', 'about', 'legal', 'search',
  'home', 'messaging', 'notifications', 'newsletters', 'mwlite', 'check', 'biz',
  'activity', 'salary', 'showcase', 'services', 'hire', 'profinder'
]);

export function isValidLinkedInHandle(handle: string): boolean {
  if (!handle || typeof handle !== 'string') return false;
  const clean = handle.trim().replace(/[.,;:)\]]+$/, '').toLowerCase();
  if (clean.length < 2 || clean.length > 100) return false;
  if (RESERVED_LINKEDIN_PATHS.has(clean)) return false;
  if (/^activity(?:[-_]|\b)/i.test(clean)) return false;
  if (/^\d+$/.test(clean)) return false;
  return /^[a-z0-9\u0080-\uffff](?:[a-z0-9_.\u0080-\uffff-]*[a-z0-9\u0080-\uffff])?$/i.test(clean);
}

export const getLinkedInHandle = (url?: string) => {
  const unwrapped = unwrapRedirectUrl(url);
  const normalized = normalizeDedupeValue(unwrapped);
  const match = normalized.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (match?.[1]) {
    let rawSegment = match[1];
    try {
      rawSegment = decodeURIComponent(rawSegment);
    } catch {}
    rawSegment = rawSegment.replace(/[.,;:)\]]+$/, '').trim();
    const handle = rawSegment.toLowerCase();
    if (isValidLinkedInHandle(handle)) return handle;
  }

  const postMatch = normalized.match(/linkedin\.com\/posts\/([^/?#]+)/i);
  if (postMatch?.[1]) {
    let segment = postMatch[1];
    if (segment.includes('_')) {
      segment = segment.split('_')[0];
    } else if (segment.includes('-activity-')) {
      segment = segment.split('-activity-')[0];
    } else if (/-activity$/i.test(segment)) {
      segment = segment.replace(/-activity$/i, '');
    }
    const handle = segment.toLowerCase();
    if (isValidLinkedInHandle(handle)) return handle;
  }

  const pulseMatch = normalized.match(/linkedin\.com\/pulse\/([^/?#]+)/i);
  if (pulseMatch?.[1]) {
    const segment = pulseMatch[1];
    if (isValidLinkedInHandle(segment)) return segment.toLowerCase();
  }

  if (normalized && !normalized.includes('/') && !normalized.includes('linkedin.com') && isValidLinkedInHandle(normalized)) {
    return normalized;
  }
  return '';
};

/**
 * The stable identity used for a real LinkedIn public profile. This is
 * deliberately narrower than getLinkedInHandle(): a bare string may be useful
 * for search inputs, but it must never become a persisted identity key.
 */
export const canonicalLinkedInIdentity = (url?: string) => {
  const unwrapped = unwrapRedirectUrl(url);
  const normalized = normalizeDedupeValue(unwrapped);
  if (!/linkedin\.com\/(?:in|posts|pulse)\//i.test(normalized)) return '';
  const handle = getLinkedInHandle(unwrapped);
  return handle ? `linkedin:${handle}` : '';
};

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
  'mail.com', 'zoho.com', 'protonmail.com', 'proton.me', 'gmx.com', 'live.com'
]);

export const getProfileDomain = (input?: Partial<LinkedInProfile> | Record<string, any>) => {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, any>;
  const p = record.profile && typeof record.profile === 'object' ? (record.profile as Record<string, any>) : record;
  const cd = (p.contactDetails && typeof p.contactDetails === 'object' ? p.contactDetails : undefined) ||
             (record.contactDetails && typeof record.contactDetails === 'object' ? record.contactDetails : {});
  const website = cd.website || record.website || p.website;
  if (website) return normalizeDedupeValue(website).split('/')[0];
  const email = cd.email || record.email || p.email;
  if (email && typeof email === 'string' && email.includes('@')) {
    const domain = email.toLowerCase().split('@')[1];
    if (domain && !GENERIC_EMAIL_DOMAINS.has(domain)) {
      return domain;
    }
  }
  return '';
};

export const buildProfileDedupeKeys = (input?: Partial<LinkedInProfile> | Record<string, any>) => {
  if (!input || typeof input !== 'object') return new Set<string>();
  const record = input as Record<string, any>;
  const p = record.profile && typeof record.profile === 'object' ? (record.profile as Record<string, any>) : record;
  const cd = (p.contactDetails && typeof p.contactDetails === 'object' ? p.contactDetails : undefined) ||
             (record.contactDetails && typeof record.contactDetails === 'object' ? record.contactDetails : {});
  const email = normalizeDedupeValue(cd.email || record.email || p.email);
  const linkedinIdentity = canonicalLinkedInIdentity(
    cd.linkedinUrl || record.linkedinUrl || p.linkedinUrl || record.sourceUrl || p.sourceUrl
  );
  const name = normalizeDedupeValue(p.fullName || record.fullName || p.name || record.name);
  const company = normalizeDedupeValue(p.currentCompany || record.currentCompany || p.company || record.company);
  const domain = getProfileDomain(input);

  const keys = new Set<string>();
  if (email) keys.add(`email:${email}`);
  if (linkedinIdentity) keys.add(linkedinIdentity);
  // A real LinkedIn profile is the authoritative person identity. Name and
  // company fallbacks are only for profiles without that stable identifier.
  if (!linkedinIdentity && name && company) keys.add(`name_company:${name}::${company}`);
  if (!linkedinIdentity && name && domain) keys.add(`name_domain:${name}::${domain}`);
  // Business leads (passed as a whole lead) also match on their Page, website and phone.
  if (record.kind === 'business' || (record.kind === undefined && record.business)) {
    for (const key of buildBusinessIdentityKeys(record.business)) keys.add(key);
  }
  return keys;
};

export const hasDuplicateProfile = (profile: Partial<LinkedInProfile> | Record<string, any>, existingKeys: Set<string>) => {
  for (const key of buildProfileDedupeKeys(profile)) {
    if (existingKeys.has(key)) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Business identity (Facebook Pages, websites, phone numbers)
// ---------------------------------------------------------------------------

/** First path segments that never name a Facebook Page. */
const RESERVED_FACEBOOK_PATHS = new Set([
  'groups', 'events', 'watch', 'marketplace', 'photo', 'photo.php', 'photos', 'story.php',
  'permalink.php', 'share', 'sharer', 'sharer.php', 'login', 'login.php', 'help', 'policies',
  'privacy', 'legal', 'hashtag', 'search', 'gaming', 'reel', 'reels', 'stories', 'ads',
  'business', 'public', 'home.php', 'notifications', 'messages', 'friends', 'bookmarks',
  'fundraisers', 'jobs', 'media', 'l.php', 'dialog', 'plugins', 'tr', 'video.php', 'videos',
  'posts', 'about', 'settings', 'pages', 'people', 'profile.php', 'watchparty', 'live', 'r.php',
  'recover', 'checkpoint', 'terms', 'cookies', 'careers', 'places', 'help.php', 'index.php',
]);

const FACEBOOK_HOST = /^(?:[a-z0-9-]+\.)?(?:facebook\.com|fb\.com)$/i;

export type FacebookPageRef = {
  /** Stable identity key: `facebook:id:<digits>` or `facebook:user:<username>`. */
  key: string;
  /** Canonical https://www.facebook.com/... URL for the Page. */
  url: string;
  pageId?: string;
  username?: string;
};

/**
 * Canonicalizes any Facebook URL that points at a Page (or a Page's sub-path such as
 * /about or /posts/...) to one stable identity. Returns null for groups, events,
 * marketplace, share links and anything that is not on facebook.com.
 *
 * A Page can be addressed by its vanity username and by its numeric id; callers that
 * know both (for example from a structured scrape) should key on both.
 */
export function canonicalFacebookPage(rawUrl?: string): FacebookPageRef | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let parsed: URL;
  try {
    const trimmed = rawUrl.trim();
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!FACEBOOK_HOST.test(parsed.hostname)) return null;

  const segments = parsed.pathname
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment).trim();
      } catch {
        return segment.trim();
      }
    })
    .filter(Boolean);
  const first = (segments[0] || '').toLowerCase();

  const byId = (id: string): FacebookPageRef => ({
    key: `facebook:id:${id}`,
    url: `https://www.facebook.com/profile.php?id=${id}`,
    pageId: id,
  });

  if (first === 'profile.php') {
    const id = parsed.searchParams.get('id') || '';
    return /^\d{5,25}$/.test(id) ? byId(id) : null;
  }
  // /people/Name/123456 and /pages/Name/123456 (also /pages/category/Cat/Name-123456)
  if (first === 'people' || first === 'pages') {
    const last = segments[segments.length - 1] || '';
    const idMatch = last.match(/(?:^|-)(\d{5,25})$/);
    return idMatch ? byId(idMatch[1]) : null;
  }
  if (!first || RESERVED_FACEBOOK_PATHS.has(first)) return null;

  // Legacy vanity form: /Some-Business-Name-123456789
  const legacyId = first.match(/-(\d{8,25})$/);
  if (legacyId) return byId(legacyId[1]);
  if (/^\d{5,25}$/.test(first)) return byId(first);

  // Facebook usernames are letters, digits and dots.
  if (!/^[a-z0-9.]{3,80}$/i.test(first) || /^\.|\.$/.test(first)) return null;
  const username = first.toLowerCase();
  return {
    key: `facebook:user:${username}`,
    url: `https://www.facebook.com/${username}`,
    username,
  };
}

/** Hosts shared by many unrelated businesses, which therefore never identify one. */
const SHARED_WEBSITE_HOSTS = new Set([
  'facebook.com', 'fb.com', 'm.facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com',
  'x.com', 'tiktok.com', 'youtube.com', 'youtu.be', 'linktr.ee', 'wa.me', 'whatsapp.com',
  'google.com', 'goo.gl', 'g.page', 'maps.app.goo.gl', 'sites.google.com', 'bit.ly',
  'tinyurl.com', 'linkin.bio', 'beacons.ai', 'etsy.com', 'amazon.com', 'ebay.com',
  'yelp.com', 'tripadvisor.com', 'booking.com', 'airbnb.com', 'wixsite.com',
]);

/** Returns `domain:<host>` for a business's own website, or '' for shared or invalid hosts. */
export function websiteDomainKey(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let host = '';
  try {
    const trimmed = rawUrl.trim();
    host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return '';
  }
  host = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!host.includes('.') || SHARED_WEBSITE_HOSTS.has(host)) return '';
  return `domain:${host}`;
}

/**
 * Returns `phone:<digits>` for a phone number with at least 7 digits. International
 * prefixes written as 00 are folded into the same key as +. Numbers written in
 * national format (0161 ...) and international format (+44 161 ...) do not match;
 * that needs a country, which a later phase can supply.
 */
export function phoneKey(raw?: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  digits = digits.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return `phone:${digits}`;
}

const asStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : typeof value === 'string' && value.trim()
      ? [value]
      : [];

/**
 * Identity keys for a business lead. Website and phone keys are only ever used for
 * businesses: two people at one company share a website, two businesses do not.
 */
export function buildBusinessIdentityKeys(business: unknown): Set<string> {
  const keys = new Set<string>();
  if (!business || typeof business !== 'object') return keys;
  const record = business as Record<string, any>;

  const page = canonicalFacebookPage(record.pageUrl);
  if (page) keys.add(page.key);
  if (typeof record.pageId === 'string' && /^\d{5,25}$/.test(record.pageId)) {
    keys.add(`facebook:id:${record.pageId}`);
  }
  if (typeof record.username === 'string' && /^[a-z0-9.]{3,80}$/i.test(record.username)) {
    keys.add(`facebook:user:${record.username.toLowerCase()}`);
  }
  for (const website of asStringList(record.websites)) {
    const key = websiteDomainKey(website);
    if (key) keys.add(key);
  }
  for (const phone of asStringList(record.phones)) {
    const key = phoneKey(phone);
    if (key) keys.add(key);
  }
  return keys;
}
