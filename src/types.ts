/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContactDetails {
  email?: string; // Manually entered, imported, or explicitly published in profile evidence.
  phone?: string;
  linkedinUrl?: string;
  twitter?: string;
  website?: string;
}

export interface Experience {
  title: string;
  company: string;
  duration?: string;
  location?: string;
  description?: string;
}

export interface Education {
  school: string;
  degree?: string;
  fieldOfStudy?: string;
  duration?: string;
}

export interface LinkedInProfile {
  id: string;
  fullName: string;
  headline?: string;
  currentCompany?: string;
  currentTitle?: string;
  seniorityLevel?: string; // C-Suite / Founder-Owner / VP / Head / Director / Manager / IC / Assistant / Student / Unknown
  companySizeEst?: string; // New: 1-10 / 11-50 / 51-200 / 201-500 / 500+ / UNKNOWN
  location?: string;
  summary?: string;
  contactDetails?: ContactDetails;
  experiences?: Experience[];
  education?: Education[];
  skills?: string[];
  industry?: string;
  yearsInRole?: string; // New
  careerSignals?: string[]; // New: notable transitions, promotions
  techStackHints?: string[]; // New: tools/software mentioned
  painIndicators?: string[]; // New: specific quoted phrases or inferred needs
  enrichmentGaps?: string[]; // New
}


export interface BuyingSignal {
  type: 'LEAD_FLOW' | 'OPERATIONAL_COMPLEXITY' | 'GROWTH_SIGNAL' | 'DECISION_MAKER' | 'DISQUALIFIER';
  label: string;
  evidence: string;
  sourceUrl?: string;
  confidence: number;
}

export interface CompanyAccount {
  id: string;
  name: string;
  website?: string;
  industry?: string;
  location?: string;
  sizeEstimate?: 'solo' | 'small-team' | 'mid-market' | 'enterprise' | 'unknown';
  buyingSignals: BuyingSignal[];
  disqualifiers?: BuyingSignal[];
  operationalPainScore: number;
  qualificationStatus: 'DISCOVERED' | 'QUALIFIED' | 'REJECTED' | 'NEEDS_REVIEW';
  painSummary?: string;
}

export interface DecisionMakerVerification {
  titleMatched: boolean;
  companyMatched: boolean;
  ignoredTitle: boolean;
  confidence: number;
  reason: string;
  trajectoryScore?: number;
}

export type EvidenceQuality = 'weak' | 'partial' | 'good';
export type LeadSourceProvider = 'tavily' | 'brightdata' | 'cache' | 'manual' | 'import';

export interface LeadEvidence {
  sourceUrl: string;
  sourceProvider: LeadSourceProvider;
  sourceQuery: string;
  sourceRound: number;
  evidenceQuality: EvidenceQuality;
  snippets: string[];
  whyThisLead?: string;
}

export type PostIntentCategory =
  | 'hiring'
  | 'evaluating_tools'
  | 'pain_signal'
  | 'growth_signal'
  | 'general'
  | 'none';

export type PostIntentQuality = 'strong' | 'moderate' | 'weak' | 'none';

export type IntentEnrichmentState = 'not_enriched' | 'enriched_none' | 'enriched_signal';

export interface PostIntentEvidence {
  queriedAt: string;
  postSnippets: string[];
  intentKeywords: string[];
  intentCategory: PostIntentCategory;
  confidenceScore: number;
  quality: PostIntentQuality;
  llmReason: string;
  sourceUrl?: string;
}

export interface ScoreBreakdown {
  fitScore: number;
  intentScore: number;
  timingScore: number;
  evidenceQualityScore: number;
  sourceConfidenceScore: number;
  finalScore: number;
  postIntentScore?: number;
  confidenceInterval?: {
    lower: number;
    upper: number;
    uncertainty: number;
  };
}

export interface ScoutEvidence {
  matchedCriteria: string[];
  sourceCount: number;
  sourceProviders: string[];
  lanes: string[];
  criteriaCoverageScore: number;
  corroborationScore: number;
  evidenceCoverageScore: number;
  uncertainties: string[];
}

export interface QualifiedLeadProfile extends LinkedInProfile {
  companyAccount?: CompanyAccount;
  decisionMakerVerification?: DecisionMakerVerification;
  sourceProvider?: LeadSourceProvider;
  scoreOverride?: number;
  evidenceReasons?: string[];
  evidence?: LeadEvidence;
  scoreBreakdown?: ScoreBreakdown;
  scout?: ScoutEvidence;
  finalSelectionScore?: number;
  discoveryLane?: string;
  paretoSkyline?: boolean;
  postIntentEvidence?: PostIntentEvidence;
  intentEnrichmentState?: IntentEnrichmentState;
  buyingSignalsDetected?: string[];
  hiringSignalUrl?: string;
  confidenceInterval?: {
    lower: number;
    upper: number;
    uncertainty: number;
  };
}

export const LEAD_STAGES = ['SCRAPED', 'ENRICHED', 'SEQUENCE ACTIVE', 'REPLIED', 'MEETING BOOKED', 'NEGOTIATING', 'CONVERTED', 'LOST', 'NURTURE'] as const;
export const REVIEW_STATUSES = ['UNREVIEWED', 'KEEP', 'MAYBE', 'REJECT'] as const;
export const NEXT_ACTIONS = ['NONE', 'OPEN_LINKEDIN', 'OPEN_FACEBOOK', 'RESEARCH', 'CONNECT', 'MESSAGE', 'CALL', 'EMAIL'] as const;
/** A lead is either a person (LinkedIn-first discovery) or a business (for example a Facebook Page). */
export const LEAD_KINDS = ['person', 'business'] as const;
/** Where a lead came from. Derived by getLeadSource() when not stored explicitly. */
export const LEAD_SOURCES = ['linkedin', 'facebook', 'maps', 'import', 'manual', 'other'] as const;

export type LeadStage = typeof LEAD_STAGES[number];
export type ReviewStatus = typeof REVIEW_STATUSES[number];
export type NextAction = typeof NEXT_ACTIONS[number];
export type LeadKind = typeof LEAD_KINDS[number];
export type LeadSource = typeof LEAD_SOURCES[number];

export const LEAD_STAGE_SET = new Set<string>(LEAD_STAGES);
export const REVIEW_STATUS_SET = new Set<string>(REVIEW_STATUSES);
export const NEXT_ACTION_SET = new Set<string>(NEXT_ACTIONS);
export const LEAD_KIND_SET = new Set<string>(LEAD_KINDS);
export const LEAD_SOURCE_SET = new Set<string>(LEAD_SOURCES);

/**
 * Structured facts about a business lead, read from a public source such as a
 * Facebook Page. Contact fields come from the source record, never from an LLM.
 */
export interface BusinessDetails {
  name: string;
  pageUrl?: string;
  pageId?: string;
  username?: string;
  category?: string;
  categories?: string[];
  about?: string;
  address?: string;
  city?: string;
  country?: string;
  phones?: string[];
  emails?: string[];
  websites?: string[];
  followers?: number;
  rating?: number;
  ratingCount?: number;
  verified?: boolean;
  ownerName?: string;
  ownerSource?: 'page' | 'website' | 'linkedin' | 'manual';
  /** 0-1 confidence that ownerName is the owner. */
  ownerConfidence?: number;
  /** ISO time the source record was read. */
  fetchedAt?: string;
  /** 'partial' when the structured read failed and only search data is available. */
  dataQuality?: 'full' | 'partial';
}

export interface Lead {
  id: string;
  /** Incremented by SQLite on every write; included in mutations to reject stale edits. */
  revision?: number;
  profile: LinkedInProfile;
  stage: LeadStage;
  notes?: string;
  createdAt: string;
  lastActive?: string;
  lastEnrichedAt?: string;
  tags?: string[];
  reviewStatus?: ReviewStatus;
  nextAction?: NextAction;
  /** Defaults to 'person' when absent. */
  kind?: LeadKind;
  source?: LeadSource;
  business?: BusinessDetails;
  /** Set when the contact has opted out; outreach should skip this lead. */
  doNotContact?: boolean;
  
  // Analytics & Scoring from System Prompt
  icpScoreReasoning?: string; // 1-10 rating rationale
  fitScore?: number; // ICP match based on title, industry, company size
  intentScore?: number; // Buying signals
  timingScore?: number; // Recent role change, funding event
  compositeScore?: number; // (Fit * 0.4) + (Intent * 0.4) + (Timing * 0.2)
  predictiveScore?: number;
  qualificationScore?: number;
  tier?: 'TIER 1: PRIORITY' | 'TIER 2: ACTIVE' | 'TIER 3: WATCH' | 'TIER 4: DEPRIORITIZE';
  
  buyingSignalsDetected?: string[];
  hiringSignalUrl?: string;
  companyAccount?: CompanyAccount;
  decisionMakerVerification?: DecisionMakerVerification;
  sourceProvider?: LeadSourceProvider;
  evidenceReasons?: string[];
  evidence?: LeadEvidence;
  scoreBreakdown?: ScoreBreakdown;
  scout?: ScoutEvidence;
  finalSelectionScore?: number;
  discoveryLane?: string;
  paretoSkyline?: boolean;
  postIntentEvidence?: PostIntentEvidence;
  intentEnrichmentState?: IntentEnrichmentState;
  confidenceInterval?: {
    lower: number;
    upper: number;
    uncertainty: number;
  };
}

export interface ScrapingTask {
  id: string;
  type: 'url' | 'paste' | 'search';
  query: string;
  status: 'idle' | 'processing' | 'completed' | 'failed' | 'cancelled';
  resultCount?: number;
  createdAt: string;
}

export type MiningProvider = 'llm' | 'tavily' | 'brightdata' | 'sqlite' | 'system';
export type MiningPhase = 'session' | 'strategy' | 'search' | 'candidate_processing' | 'extraction' | 'filtering' | 'enrichment' | 'persistence';
export type MiningEventStatus = 'started' | 'success' | 'error' | 'skipped' | 'info';

export interface MiningTraceEvent {
  id: string;
  timestamp: string;
  phase: MiningPhase;
  operation: string;
  status: MiningEventStatus;
  provider?: MiningProvider;
  model?: string;
  round?: number;
  query?: string;
  chunk?: { index: number; total: number; inputChars?: number };
  latencyMs?: number;
  counts?: Record<string, number>;
  llm?: {
    purpose?: string;
    model?: string;
    route?: string;
    fallbackUsed?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    finishReason?: string;
    parseRetries?: number;
  };
  tavily?: { searchDepth?: string; maxResults?: number; includeDomains?: string[] };
  brightData?: { transport?: string; target?: string; targetCount?: number; circuitOpen?: boolean; cooldownMsRemaining?: number; disabledReason?: string | null };
  email?: { status?: string; cacheHit?: boolean; evidenceCount?: number; sourceTypes?: string[] };
  error?: { message: string; code?: string };
  metadata?: Record<string, unknown>;
}

export interface ProviderSummaryItem {
  calls: number;
  successes: number;
  failures: number;
  skipped: number;
  latencyMs: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  fallbackUses: number;
  models?: Record<string, number>;
}

export type ProviderSummary = Record<string, ProviderSummaryItem>;

export interface CostSummary {
  estimatedUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costPerAcceptedLead?: number;
  tokensPerAcceptedLead?: number;
}

export interface TargetEffortStats {
  mode: 'exhaustive_bounded';
  requested: number;
  selectableQualified: number;
  shortfall: number;
  waves: number;
  queryExecutions: number;
  maxQueryExecutions: number;
  acceptedCandidates: number;
  candidateCeiling: number;
  emptyWaves: number;
  estimatedQualificationYield: number;
  terminationReason: string;
}

export interface FinalistJudgeStats {
  autoQualified: number;
  reviewed: number;
  qualified: number;
  hardFailed: number;
  unknown: number;
  unjudged: number;
  batchesRun: number;
  batchesSkipped: number;
  retries: number;
  rescued: number;
}

export interface PhaseTimelineItem {
  phase: MiningPhase;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: MiningEventStatus;
  events: number;
}

export interface MiningTraceSummary {
  sessionId?: string;
  query?: string;
  requested?: number;
  status?: 'running' | 'success' | 'error';
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  stopReason?: string;
  returned?: number;
  eventCount: number;
  providerSummary: ProviderSummary;
  costSummary: CostSummary;
  phaseTimeline: PhaseTimelineItem[];
  targetEffort?: TargetEffortStats;
  finalistJudge?: FinalistJudgeStats;
  schemaVersion?: number;
  existingCrmLeadsSkipped?: number;
}
export interface SearchLog {
  id: string;
  timestamp: string;
  prompt: string;
  generatedQueries: string[];
  status: 'success' | 'error' | 'running' | 'cancelled';
  errorMessage?: string;
  rawResultsCount: number;
  leadsFound: number;
  detailedLogs?: string;
  debugLogs?: string;
  rejectionReasons?: Record<string, number>;
  queryRuns?: unknown[];
  traceSummary?: MiningTraceSummary;
  traceEvents?: MiningTraceEvent[];
  providerSummary?: ProviderSummary;
  costSummary?: CostSummary;
  phaseTimeline?: PhaseTimelineItem[];
  schemaVersion?: number;
}

export type MiningSessionStatus = 'running' | 'cancellation_requested' | 'success' | 'error' | 'cancelled' | 'interrupted';
export type MiningPersistenceStatus = 'complete' | 'partial' | 'failed';

export interface MiningSessionStats {
  rawResultsCount?: number;
  leadsFound?: number;
  duplicateCount?: number;
  existingCrmLeadsSkipped?: number;
  rounds?: number;
  [key: string]: unknown;
}

export interface MiningSession {
  id: string;
  status: MiningSessionStatus;
  persistenceStatus?: MiningPersistenceStatus;
  prompt: string;
  requestedLimit: number;
  startedAt: string;
  completedAt?: string;
  cancellationRequestedAt?: string;
  errorMessage?: string;
  stats?: MiningSessionStats | Record<string, unknown>;
  traceSummary?: MiningTraceSummary;
  updatedAt: string;
}
