import type { Lead, NextAction, QualifiedLeadProfile, ReviewStatus, ScoutEvidence } from '@/types';

export const REVIEW_STATUS_OPTIONS: { value: ReviewStatus; label: string }[] = [
  { value: 'UNREVIEWED', label: 'Unreviewed' },
  { value: 'KEEP', label: 'Keep' },
  { value: 'MAYBE', label: 'Maybe' },
  { value: 'REJECT', label: 'Reject' },
];

export const NEXT_ACTION_OPTIONS: { value: NextAction; label: string }[] = [
  { value: 'NONE', label: 'No action' },
  { value: 'OPEN_LINKEDIN', label: 'Open LinkedIn' },
  { value: 'OPEN_FACEBOOK', label: 'Open Facebook Page' },
  { value: 'RESEARCH', label: 'Research' },
  { value: 'CONNECT', label: 'Connect' },
  { value: 'MESSAGE', label: 'Message' },
  { value: 'CALL', label: 'Call' },
  { value: 'EMAIL', label: 'Email' },
];

export const getReviewStatus = (lead: Lead): ReviewStatus => lead.reviewStatus || 'UNREVIEWED';
export const getNextAction = (lead: Lead): NextAction => lead.nextAction || 'NONE';

export function getLeadProvenance(lead: Lead) {
  const profile = (lead.profile || {}) as Partial<QualifiedLeadProfile>;
  const scout: ScoutEvidence | undefined = lead.scout || profile.scout;
  const ci = lead.scoreBreakdown?.confidenceInterval || lead.confidenceInterval || profile.confidenceInterval;
  return {
    discoveryQuery: lead.evidence?.sourceQuery || profile.evidence?.sourceQuery || '',
    matchedCriteria: scout?.matchedCriteria || [],
    uncertainties: scout?.uncertainties || [],
    location: profile.location || (lead as any).location || '',
    industry: profile.industry || (lead as any).industry || '',
    scout,
    paretoSkyline: lead.paretoSkyline || profile.paretoSkyline || false,
    confidenceInterval: ci,
    postIntentEvidence: lead.postIntentEvidence || profile.postIntentEvidence,
  };
}

export const getReviewStatusLabel = (status: ReviewStatus) =>
  REVIEW_STATUS_OPTIONS.find(option => option.value === status)?.label || 'Unreviewed';

export const getNextActionLabel = (action: NextAction) =>
  NEXT_ACTION_OPTIONS.find(option => option.value === action)?.label || 'No action';
