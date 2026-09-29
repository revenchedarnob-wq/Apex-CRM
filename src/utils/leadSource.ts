import {
  LEAD_KIND_SET,
  LEAD_SOURCE_SET,
  type LeadKind,
  type LeadSource,
} from '../types';
import { canonicalFacebookPage, canonicalLinkedInIdentity } from './leadDedupe';

/** A lead is a business when it says so, or when it carries business details. */
export function getLeadKind(lead: unknown): LeadKind {
  if (!lead || typeof lead !== 'object') return 'person';
  const record = lead as Record<string, any>;
  if (typeof record.kind === 'string' && LEAD_KIND_SET.has(record.kind)) {
    return record.kind as LeadKind;
  }
  return record.business && typeof record.business === 'object' ? 'business' : 'person';
}

/**
 * Where a lead came from. Uses the stored `source` when valid; otherwise derives it
 * so leads saved before sources existed still filter correctly.
 */
export function getLeadSource(lead: unknown): LeadSource {
  if (!lead || typeof lead !== 'object') return 'other';
  const record = lead as Record<string, any>;
  if (typeof record.source === 'string' && LEAD_SOURCE_SET.has(record.source)) {
    return record.source as LeadSource;
  }
  if (canonicalFacebookPage(record.business?.pageUrl)) return 'facebook';
  const profile = record.profile && typeof record.profile === 'object' ? record.profile : {};
  const linkedinUrl =
    profile.contactDetails?.linkedinUrl || record.contactDetails?.linkedinUrl || record.linkedinUrl;
  if (canonicalLinkedInIdentity(linkedinUrl)) return 'linkedin';
  if (record.sourceProvider === 'import') return 'import';
  if (record.sourceProvider === 'manual') return 'manual';
  return 'other';
}

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  maps: 'Map listing',
  import: 'Imported',
  manual: 'Added manually',
  other: 'Other',
};
