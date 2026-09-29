import { Type } from "../services/llm.js";
import {
  isAgencyContract,
  type ProspectContract,
  type ProspectRequirement,
} from "./prospectContract.js";
import { isFlagEnabled } from "./featureFlags.js";
import {
  hasStrictStructuredMatch,
  selectEvidenceForFinalist,
} from "./evidenceSelection.js";
import { rankLeadForFinalSelection } from "./scoring.js";
import { aliasIncludes, normalizeAliasTerm } from "./aliasMap.js";
import {
  classifyTitle,
  evaluateDecisionMakerGate,
} from "./titleTriage.js";
import {
  candidateMatchesWrongVertical,
  contractMentionsVertical,
  extractSocialProof,
  getWrongVerticalRegexForCluster,
  isCompanyPageProfile,
  isGhostProfile,
} from "./profileQuality.js";
import { deriveDomainCluster } from "./adaptiveScheduler.js";

export type RequirementStatus = "pass" | "fail" | "unknown";

export type RequirementAssessment = {
  requirementId: string;
  status: RequirementStatus;
  evidenceId?: string;
  evidenceQuote?: string;
  reason?: string;
  /** True when the model claimed a pass but the cited quote was not found in the candidate evidence. */
  fabricatedPass?: boolean;
};

export type FinalistJudgment = {
  candidateId: string;
  requirements: RequirementAssessment[];
  semanticFit: number;
  authorityFit: number;
  evidenceConfidence: number;
  verdict: "qualified" | "qualified_partial" | "not_qualified";
  reason: string;
};

export type FinalistCandidate = {
  candidateId: string;
  lead: Record<string, any>;
  evidence: Array<{ id: string; text: string }>;
};

/**
 * Phase 0 baseline telemetry (non-behavioral counters, G1/G2 observability).
 * Incremented on every judge path; no behavior change. Lets the eval harness
 * prove uncited passes -> ~0 after Phase 1.
 */
export const judgeEvidenceTelemetry = {
  uncitedPasses: 0,
  companyDerivedLocationAutoPasses: 0,
};

export function resetJudgeEvidenceTelemetry() {
  judgeEvidenceTelemetry.uncitedPasses = 0;
  judgeEvidenceTelemetry.companyDerivedLocationAutoPasses = 0;
}

export type Qualification = {
  policyVersion: string;
  verdict: "qualified" | "qualified_partial" | "unverified";
  qualificationSource: "llm" | "deterministic";
  finalScore: number;
  requirements: RequirementAssessment[];
  reason: string;
  semanticFit: number;
  evidenceConfidence: number;
  authorityFit: number;
  scoresOmitted?: boolean;
};

const clean = (value: unknown, max = 900) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const normalizeScoreTo10 = (value: unknown, defaultVal = 5): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultVal;
  // If the score was returned on a 0.0 - 1.0 probability/unit scale, scale it to 0 - 10
  if (num < 1.0 && num > 0)
    return Math.min(10, Math.max(0, Number((num * 10).toFixed(2))));
  return Math.min(10, Math.max(0, Number(num.toFixed(2))));
};
export const finalistJudgeSchema = {
  type: Type.OBJECT,
  properties: {
    judgments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          candidateId: { type: Type.STRING },
          requirements: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                requirementId: { type: Type.STRING },
                status: { type: Type.STRING },
                evidenceId: { type: Type.STRING },
                evidenceQuote: { type: Type.STRING },
                reason: { type: Type.STRING },
              },
              required: ["requirementId", "status"],
            },
          },
          semanticFit: {
            type: Type.NUMBER,
            description:
              "Semantic fit score from 1 to 10 evaluating how well the candidate matches the contract role and requirements.",
          },
          authorityFit: {
            type: Type.NUMBER,
            description:
              "Authority fit score from 1 to 10 evaluating seniority and decision-making power.",
          },
          evidenceConfidence: {
            type: Type.NUMBER,
            description:
              "Evidence confidence score from 1 to 10 evaluating proof clarity and certainty.",
          },
          reason: { type: Type.STRING },
        },
        required: [
          "candidateId",
          "requirements",
          "semanticFit",
          "authorityFit",
          "evidenceConfidence",
          "reason",
        ],
      },
    },
  },
  required: ["judgments"],
};

export type FinalistOutcomeStatus =
  | "qualified"
  | "qualified_partial"
  | "hard_fail"
  | "unknown"
  | "unjudged"
  | "unverified";

export type CandidateOutcome = {
  candidateId: string;
  status: FinalistOutcomeStatus;
  qualification?: Qualification;
  requirements?: RequirementAssessment[];
  reason?: string;
};

export const FINALIST_JUDGE_SYSTEM_PROMPT = `You are a senior B2B sales intelligence evaluator. Assess each candidate's fit for the role described in the prospect contract.

CORE RULES:
1. Evaluate semantic fit, not exact keyword matching. Real B2B profiles rarely use the exact same phrasing as a search query.
2. LOCATION equivalence (always apply):
   - Any city, state, metro area, or region that is physically inside the target country = PASS
   - "San Francisco CA", "New York", "Boston", "United States", "US", "U.S.", "America" all satisfy "USA"
   - UK / United Kingdom / England / Scotland / London all satisfy "UK"
3. ROLE & OWNERSHIP equivalence:
   - "Founder", "Co-Founder", "Proprietor", "Owner", "Managing Partner", "Managing Director", "Principal", "CEO", "President" satisfy executive leadership and ownership requirements for agencies and businesses.
   - When a brief seeks agency owners/founders (e.g. "owner/founder", "agency owner", "founder or CEO"), verified Founders, Co-Founders, Owners, CEOs, and Managing Directors of the firm satisfy the person_role requirement.
4. COMPANY TYPE & CLIENT SERVICES vs SOFTWARE PRODUCTS:
   - "AI agency", "AI consultancy", "AI services firm", "AI studio", "AI marketing agency", "AI integrator" satisfy an AI agency requirement.
   - When the contract specifies agencies, consultancies, studios, integrators, or client services: the candidate's firm MUST be a client-services business.
   - Software products, SaaS platforms, consumer apps, B2C mobile apps (e.g. personal trainer apps, habit trackers, consumer utilities), developer tools, and tech vendor platforms do NOT satisfy an agency requirement. Mark status: "fail" for company_type.
   - Non-agency employers (Big Tech: Microsoft, Google, Meta, Apple, Amazon, OpenAI, etc.) and individual contributor roles (Staff/Principal Engineer, Product Manager) do NOT satisfy agency owner/founder requirements. Mark status: "fail".
   - ABSENCE OF EVIDENCE IS NOT A FAIL FOR COMPANY TYPE/INDUSTRY: If a candidate's snippet only shows their title and company name (or a brief bio) without describing the company's business model in detail, and does NOT explicitly show a disqualifying model (such as a SaaS product, consumer app, university, government body, or Big Tech employer), you MUST mark company_type / company_industry as "unknown", NEVER "fail".
5. EVIDENCE rules:
   - For every hard requirement with status "pass", you MUST populate evidenceId (the [eN] tag of the evidence block containing the proof) and evidenceQuote (a short verbatim quote from that evidence, 5-40 words, that supports the verdict).
   - For soft/signal requirements, evidenceId and evidenceQuote are optional.
   - "unknown" is used when evidence is insufficient or ambiguous.
   - "fail" is used ONLY when evidence explicitly contradicts a hard requirement.
6. A candidate passes a hard requirement when the evidence clearly supports the semantic intent of the requirement per the rules above.
7. SIGNAL & SOFT REQUIREMENTS:
   - For soft/ranking signal requirements (e.g. specific tooling like n8n, hiring triggers, client delivery bottlenecks): assign status "pass" if evidence demonstrates or mentions it, "fail" if explicitly contradicted, or "unknown" if evidence lacks mention.
   - Failing or unknown soft requirements do NOT trigger hard_fail.
8. SCORING SCALE & INTENT CALIBRATION:
   - For semanticFit, authorityFit, and evidenceConfidence, return a score on a 1 to 10 scale (where 10 = perfect match, 8-9 = strong match, 6-7 = good match, 4-5 = moderate match, 1-3 = weak match).
   - When soft/intent requirements (e.g. tooling, specific pain points) are present in the contract, a candidate who satisfies identity (e.g. agency owner) but has ZERO evidence for the soft/intent requirements MUST be rated moderate (semanticFit 4-6), NOT high (8-10). Reserve 8-10 for candidates who demonstrate both identity AND intent/tooling alignment.
9. PROPORTIONAL REASONING & STRUCTURED OUTPUT: Keep internal reasoning focused on verifying each candidate's evidence against the contract requirements, then emit the JSON judgment block.`;

const clampEnvInt = (
  name: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0
    ? Math.min(Math.max(Math.floor(raw), min), max)
    : fallback;
};

export function buildFinalistJudgePrompt(
  contract: ProspectContract,
  candidates: FinalistCandidate[],
) {
  const activeRequirements = contract.requirements;
  const requirementText = activeRequirements
    .map(
      (requirement) =>
        `- ${requirement.id} [${requirement.importance}/${requirement.scope}]: ${requirement.description}; acceptable terms and semantic equivalents: ${requirement.acceptableTerms.join(" | ")}`,
    )
    .join("\n");
  const allTerms = activeRequirements.flatMap((requirement) =>
    requirement.acceptableTerms.map((term) => String(term).toLowerCase()),
  );
  const batchLen = Math.max(1, candidates.length);
  const configuredMaxItems = clampEnvInt(
    "FINALIST_JUDGE_MAX_EVIDENCE_ITEMS",
    5,
    1,
    10,
  );
  const configuredEvidenceChars = clampEnvInt(
    "FINALIST_JUDGE_EVIDENCE_CHARS",
    1800,
    200,
    4800,
  );
  const dynamicMaxItems = process.env.FINALIST_JUDGE_MAX_EVIDENCE_ITEMS
    ? configuredMaxItems
    : batchLen <= 3
      ? 8
      : batchLen <= 6
        ? 6
        : configuredMaxItems;
  const dynamicEvidenceChars = process.env.FINALIST_JUDGE_EVIDENCE_CHARS
    ? configuredEvidenceChars
    : batchLen <= 3
      ? 3600
      : batchLen <= 6
        ? 2400
        : configuredEvidenceChars;
  const candidateText = candidates
    .map((candidate) => {
      const lead = candidate.lead;
      // Keep the first item (primary profile evidence), then any item containing
      // a contract acceptable term, then fill remaining slots in order. This
      // prevents truncation from dropping the evidence a verdict hinges on.
      const candEvidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
      const selected: typeof candEvidence = [];
      for (const item of candEvidence) {
        if (selected.length >= dynamicMaxItems) break;
        if (item === candEvidence[0]) {
          selected.push(item);
          continue;
        }
        const text = String(item.text || "").toLowerCase();
        if (
          item.id === "e_company_attr" ||
          allTerms.some((term) => term && text.includes(term))
        )
          selected.push(item);
      }
      for (const item of candEvidence) {
        if (selected.length >= dynamicMaxItems) break;
        if (!selected.includes(item)) selected.push(item);
      }
      const evidence = selected
        .map((item) => {
          const rawText = clean(item.text, Math.max(2000, dynamicEvidenceChars + 200));
          if (rawText.length <= dynamicEvidenceChars) {
            return `[${item.id}] ${rawText || "No evidence."}`;
          }
          const lower = rawText.toLowerCase();
          const matchIndex = allTerms
            .map((term) => (term ? lower.indexOf(term.toLowerCase()) : -1))
            .filter((idx) => idx >= 0)
            .sort((a, b) => a - b)[0];
          if (matchIndex === undefined) {
            return `[${item.id}] ${rawText.slice(0, Math.max(1, dynamicEvidenceChars - 3)).trim()}...`;
          }
          const start = Math.max(0, matchIndex - Math.floor(dynamicEvidenceChars * 0.3));
          const end = Math.min(rawText.length, start + Math.max(1, dynamicEvidenceChars - 6));
          const cropped = `${start > 0 ? "..." : ""}${rawText.slice(start, end).trim()}${end < rawText.length ? "..." : ""}`;
          return `[${item.id}] ${cropped}`;
        })
        .join("\n");
      const ablatedReq = lead._ablatedRequirementId;
      const ablatedNote = ablatedReq
        ? `\nRelaxed Requirement: Requirement "${ablatedReq}" was intentionally ablated/relaxed during search query generation for this candidate. Treat "${ablatedReq}" as optional/unknown rather than failing the candidate.`
        : "";
      const hasE0 = selected.some((item) => item.id === "e0");
      const headerFields = hasE0
        ? ""
        : `\nName: ${clean(lead.fullName, 160) || "Unknown"}\nTitle: ${clean(lead.currentTitle || lead.headline, 180) || "Unknown"}\nCompany: ${clean(lead.currentCompany, 180) || "Unknown"}\nLocation: ${clean(lead.location, 160) || "Unknown"}`;
      return `### ${candidate.candidateId}${headerFields}${ablatedNote}\nEvidence:\n${evidence}`;
    })
    .join("\n\n");
  const isAgencyBrief = /\b(agenc|consult|studio|firm|services|integrat)\b/i.test(contract.brief) ||
    contract.requirements.some(r => (r.scope === 'company_type' || r.scope === 'company_industry') && /\b(agenc|consult|studio|firm|services|integrat)\b/i.test(`${r.description} ${r.acceptableTerms.join(' ')}`));
  const agencyGuidance = isAgencyBrief
    ? `\nClient Services vs Software Products: The contract requires a client-services firm (agency/consultancy/studio/integrator). Pure software products, SaaS platforms, consumer apps, Big Tech employees, and IC roles FAIL company_type or person_role with status: 'fail'.\n`
    : '';
  return `Prospect contract:\n${requirementText}\n\nCandidates:\n${candidateText}\n${agencyGuidance}\nFor every listed candidate, assess every requirement. For each requirement return requirementId and status. For hard requirements with status "pass", also return evidenceId and a short verbatim evidenceQuote (5-40 words). Return judgments only.`;
}

const normalizePassage = (text: string): string =>
  String(text || '')
    .replace(/[\u201C\u201D"'\u2018\u2019`]/g, ' ')
    .replace(/[\u2014\u2013-]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** G1: explicit grounding mode. strict (default) requires a resolvable citation; legacy replays historical behavior. */
export function evidenceGroundingMode(): 'strict' | 'legacy' {
  const raw = String(process.env.EVIDENCE_GROUNDING_MODE || '').trim().toLowerCase();
  if (raw === 'legacy') return 'legacy';
  return 'strict';
}

export function verifyEvidencePassage(
  evidenceText: string,
  citedQuote: string,
  threshold = 0.70
): { valid: boolean; similarity: number } {
  if (!citedQuote || !citedQuote.trim()) {
    // G1 strict: an empty citation proves nothing.
    if (evidenceGroundingMode() === 'strict') return { valid: false, similarity: 0.0 };
    return { valid: true, similarity: 1.0 };
  }
  if (!evidenceText || !evidenceText.trim()) return { valid: false, similarity: 0.0 };

  const NEGATORS = new Set(['not', 'no', 'isnt', 'isn', 'without', 'stopped', 'never', 'dont', 'doesnt', 'hasnt', 'wont', 'cannot', 'cant', 'nope', 'none']);
  const PAST_ROLE_MARKERS = new Set(['former', 'previously', 'ex', 'past', 'formerly', 'retired', 'departed', 'left']);
  const normNeg = (t: string) => t.toLowerCase().replace(/[^a-z]/g, '');

  const normQuote = normalizePassage(citedQuote);
  const rawQuoteTokens = normQuote.split(' ').filter(Boolean);
  const quoteTokens = rawQuoteTokens.map(t => normalizeAliasTerm(t) || t);
  const quoteNeg = new Set(quoteTokens.map(normNeg).filter(t => NEGATORS.has(t) || PAST_ROLE_MARKERS.has(t)));

  const hasStrayNegator = (tokens: string[]): boolean => {
    for (const rawTok of tokens) {
      const tok = normNeg(rawTok);
      if ((NEGATORS.has(tok) || PAST_ROLE_MARKERS.has(tok)) && !quoteNeg.has(tok)) {
        return true;
      }
    }
    return false;
  };

  if (evidenceText.includes(citedQuote)) {
    // Check preceding tokens within the same clause/sentence for negators or past-role markers
    const matchIdx = evidenceText.indexOf(citedQuote);
    const clauseBefore = evidenceText.slice(0, matchIdx).split(/[.;!?\n|\u2014\u2013]+/).pop() || '';
    const precedingTokens = normalizePassage(clauseBefore).split(' ').filter(Boolean).slice(-4);
    if (hasStrayNegator(precedingTokens)) {
      return { valid: false, similarity: 0.49 };
    }
    return { valid: true, similarity: 1.0 };
  }

  const rawClauses = evidenceText.split(/[.;!?\n|\u2014\u2013]+/);
  const rawEvidenceTokens: string[] = [];
  const evidenceTokens: string[] = [];
  const tokenClauseIdx: number[] = [];
  rawClauses.forEach((clause, cIdx) => {
    const cNorm = normalizePassage(clause);
    for (const rawTok of cNorm.split(' ').filter(Boolean)) {
      rawEvidenceTokens.push(rawTok);
      evidenceTokens.push(normalizeAliasTerm(rawTok) || rawTok);
      tokenClauseIdx.push(cIdx);
    }
  });

  const normEvidence = normalizePassage(evidenceText);

  if (normEvidence.includes(normQuote) && rawQuoteTokens.length > 0) {
    // Locate token index of the normalized quote match to check same-clause preceding tokens
    let matchStartTok = -1;
    for (let i = 0; i <= rawEvidenceTokens.length - rawQuoteTokens.length; i++) {
      let allMatch = true;
      for (let j = 0; j < rawQuoteTokens.length; j++) {
        if (rawEvidenceTokens[i + j] !== rawQuoteTokens[j]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        matchStartTok = i;
        break;
      }
    }
    if (matchStartTok >= 0) {
      const matchClause = tokenClauseIdx[matchStartTok];
      const precedingSameClause: string[] = [];
      for (let i = Math.max(0, matchStartTok - 4); i < matchStartTok; i++) {
        if (tokenClauseIdx[i] === matchClause) {
          precedingSameClause.push(rawEvidenceTokens[i]);
        }
      }
      if (hasStrayNegator(precedingSameClause)) {
        return { valid: false, similarity: 0.49 };
      }
    }
    return { valid: true, similarity: 1.0 };
  }

  if (quoteTokens.length === 0) {
    if (evidenceGroundingMode() === 'strict') return { valid: false, similarity: 0.0 };
    return { valid: true, similarity: 1.0 };
  }
  if (evidenceTokens.length === 0) return { valid: false, similarity: 0.0 };

  // Set-based token containment
  const evidenceTokenSet = new Set(evidenceTokens);
  let matchedTokens = 0;
  for (const qt of quoteTokens) {
    if (evidenceTokenSet.has(qt)) {
      matchedTokens++;
    } else {
      for (const et of evidenceTokens) {
        if (et.length >= 3 && qt.length >= 3 && (et.startsWith(qt) || qt.startsWith(et))) {
          matchedTokens += 0.8;
          break;
        }
      }
    }
  }
  const setOverlap = Math.min(1.0, matchedTokens / quoteTokens.length);

  // Sliding window matching
  const windowSize = quoteTokens.length;
  let maxSimilarity = setOverlap * 0.9;
  let bestWindowStart = 0;
  let bestWindowSim = -1;

  for (let i = 0; i <= evidenceTokens.length - Math.min(windowSize, evidenceTokens.length); i++) {
    const candidateSlice = evidenceTokens.slice(i, i + windowSize);
    let matchCount = 0;
    for (let j = 0; j < candidateSlice.length; j++) {
      if (candidateSlice[j] === quoteTokens[j]) {
        matchCount++;
      } else if (
        candidateSlice[j].length >= 3 &&
        quoteTokens[j].length >= 3 &&
        (candidateSlice[j].startsWith(quoteTokens[j]) || quoteTokens[j].startsWith(candidateSlice[j]))
      ) {
        matchCount += 0.8;
      }
    }
    const sim = matchCount / windowSize;
    if (sim > bestWindowSim) {
      bestWindowSim = sim;
      bestWindowStart = i;
    }
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
    }
    if (maxSimilarity >= 1.0) break;
  }

  // G9: ordered sliding-window is the primary signal (0.7), set overlap
  // secondary (0.3) so paraphrases with reordered words still pass but
  // order-blind containment alone cannot dominate.
  const finalSim = maxSimilarity * 0.7 + setOverlap * 0.3;

  // G9 negation-polarity guard: a negator adjacent to the matched span in
  // the same clause of evidence that is absent from the quote rejects regardless of overlap.
  let windowHasStrayNegator = false;
  const wSize = Math.min(windowSize, evidenceTokens.length);
  const startClause = tokenClauseIdx[bestWindowStart] ?? 0;
  const endClause = tokenClauseIdx[Math.min(evidenceTokens.length - 1, bestWindowStart + wSize - 1)] ?? startClause;
  const checkStart = Math.max(0, bestWindowStart - 4);
  const checkEnd = Math.min(evidenceTokens.length, bestWindowStart + wSize + 3);
  for (let i = checkStart; i < checkEnd; i++) {
    if (i < bestWindowStart && tokenClauseIdx[i] !== startClause) continue;
    if (i >= bestWindowStart + wSize && tokenClauseIdx[i] !== endClause) continue;
    const tok = normNeg(evidenceTokens[i]);
    if ((NEGATORS.has(tok) || PAST_ROLE_MARKERS.has(tok)) && !quoteNeg.has(tok)) {
      windowHasStrayNegator = true;
      break;
    }
  }
  if (windowHasStrayNegator) {
    return { valid: false, similarity: Number(Math.min(finalSim, 0.49).toFixed(2)) };
  }

  return {
    valid: finalSim >= threshold,
    similarity: Number(finalSim.toFixed(2))
  };
}

const normalizeAssessment = (
  raw: any,
  candidate: FinalistCandidate,
  requirement: ProspectRequirement,
): RequirementAssessment => {
  const rawStatus = typeof raw?.status === "string" ? raw.status.trim().toLowerCase() : "";
  let status: RequirementStatus =
    rawStatus === "pass" || rawStatus === "fail"
      ? rawStatus
      : rawStatus === "qualified" || rawStatus === "passed"
      ? "pass"
      : rawStatus === "disqualified" || rawStatus === "failed"
      ? "fail"
      : "unknown";
  const evidenceId = clean(raw?.evidenceId, 100);
  const evidenceQuote = clean(raw?.evidenceQuote, 400);
  const reasonText = clean(raw?.reason, 280);
  const evidence = candidate.evidence.find((item) => item.id === evidenceId);

  // Guard company_type / company_industry against false hard-fails when snippet merely lacks detail
  if (
    status === "fail" &&
    (requirement.scope === "company_type" || requirement.scope === "company_industry") &&
    candidate.lead?.companyAttribution?.verdict !== "disqualifying_contradiction"
  ) {
    const isMissingEvidenceFail =
      /\b(not\s+(?:explicitly\s+)?(?:mention|state|specif|provid|clear|confirm|detail|describ|indicat|verify|verified)|no\s+(?:explicit\s+)?(?:evidence|mention|information|detail|indication|proof|description)|cannot\s+(?:verify|confirm|determine|establish)|insufficient|unclear|unverified|unknown|ambiguous|lacks?\s+(?:detail|information|evidence|description)|does\s+not\s+(?:mention|state|specify|describe|clarify))\b/i.test(
        reasonText,
      ) &&
      !/\b(saas|software\s+product|consumer\s+app|mobile\s+app|university|government|non-?profit|hospital|retail\s+store|e-?commerce\s+brand|contradict)\b/i.test(
        reasonText,
      );
    if (isMissingEvidenceFail) {
      status = "unknown";
    }
  }

  let matchedEvidenceId = evidenceId;
  let quoteValid = false;
  if (status !== 'pass') {
    quoteValid = true;
  } else if (!evidenceQuote) {
    // Soft/signal requirements explicitly allow optional quotes per prompt Rule 5
    if (requirement.importance !== 'hard') {
      quoteValid = true;
    } else if (evidenceGroundingMode() === 'legacy') {
      // G1: strict (default) degrades uncited hard passes to unknown; legacy preserves replay.
      quoteValid = !process.env.ENFORCE_CITATION_QUOTES;
    } else {
      quoteValid = false;
    }
    // Phase 0 counter (telemetry only): count passes that would be uncited.
    if (status === 'pass' && requirement.importance === 'hard') {
      judgeEvidenceTelemetry.uncitedPasses++;
    }
    // NOTE: Do NOT set fabricatedPass here. An omitted quote is a citation gap,
    // not an actively fabricated claim. fabricatedPass is reserved for quotes
    // that were provided but don't match any evidence passage.
  } else if (!isFlagEnabled.fuzzyQuoteGrounding()) {
    quoteValid = Boolean(evidence && evidence.text.includes(evidenceQuote));
  } else if (evidence && verifyEvidencePassage(evidence.text, evidenceQuote).valid) {
    quoteValid = true;
  } else {
    // Multi-evidence fallback scan: check if quote is present in any other candidate evidence
    for (const altEvidence of candidate.evidence) {
      if (altEvidence.text) {
        const isMatch = verifyEvidencePassage(altEvidence.text, evidenceQuote).valid;
        if (isMatch) {
          quoteValid = true;
          matchedEvidenceId = altEvidence.id;
          break;
        }
      }
    }
  }

  return {
    requirementId: requirement.id,
    status: quoteValid ? status : "unknown",
    fabricatedPass: status === "pass" && !quoteValid && Boolean(evidenceQuote),
    evidenceId: quoteValid ? matchedEvidenceId || undefined : undefined,
    evidenceQuote: quoteValid ? evidenceQuote || undefined : undefined,
    reason: reasonText || undefined,
  };
};

/**
 * Validate judgments and assign tiered outcome statuses:
 * - Any failed hard requirement (identity or context) -> hard_fail
 * - All hard profile requirements pass + all hard signal requirements pass -> qualified
 * - Identity (person_role) verified, but context attributes (location, company
 *   type, industry, size) and/or hard signals merely unknown -> qualified_partial
 *   (15% score discount). Search snippets routinely omit context fields, so an
 *   unverifiable context no longer discards a verified decision-maker.
 * - Identity unverifiable but the judge rates semantic fit >= 6.5 and authority
 *   fit >= 7.5 (>= 7.0 when authority is not required) -> qualified_partial
 * - A "pass" whose evidence quote is absent from the packet is treated as a
 *   fabrication signal and blocks qualification entirely -> unknown
 * - Omitted or malformed candidate result -> unjudged
 */
export function validateFinalistJudgments(
  raw: unknown,
  contract: ProspectContract,
  candidates: FinalistCandidate[],
): {
  qualifications: Map<string, Qualification>;
  outcomes: Map<string, CandidateOutcome>;
  validJudgmentCount: number;
  expectedJudgmentCount: number;
  counts: {
    qualified: number;
    hardFail: number;
    unknown: number;
    unjudged: number;
  };
} {
  const byCandidate = new Map(
    candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const rawJudgments = Array.isArray((raw as any)?.judgments)
    ? (raw as any).judgments
    : [];
  const qualifications = new Map<string, Qualification>();
  const outcomes = new Map<string, CandidateOutcome>();
  let validJudgmentCount = 0;
  const counts = { qualified: 0, hardFail: 0, unknown: 0, unjudged: 0 };

  const hardRequirements = contract.requirements.filter(
    (req) => req.importance === "hard",
  );
  const profileHardReqs = hardRequirements.filter(
    (r) =>
      (r.evidenceModality ||
        (r.scope === "signal" ? "open_web_signal" : "structured_profile")) !==
      "open_web_signal",
  );
  const signalHardReqs = hardRequirements.filter(
    (r) =>
      (r.evidenceModality ||
        (r.scope === "signal" ? "open_web_signal" : "structured_profile")) ===
      "open_web_signal",
  );

  for (const candidate of candidates) {
    outcomes.set(candidate.candidateId, {
      candidateId: candidate.candidateId,
      status: "unjudged",
    });
  }

  for (const judgment of rawJudgments) {
    const candidateId = clean(judgment?.candidateId, 180);
    const candidate = byCandidate.get(candidateId);
    if (
      !candidate ||
      !Array.isArray(judgment?.requirements) ||
      judgment.requirements.length === 0
    )
      continue;

    const assessmentById = new Map(
      judgment.requirements
        .filter((item: any) => item && typeof item.requirementId === "string")
        .map((item: any) => [item.requirementId, item]),
    );
    const requirements = contract.requirements.map((requirement) =>
      normalizeAssessment(
        assessmentById.get(requirement.id),
        candidate,
        requirement,
      ),
    );
    validJudgmentCount++;

    // Tiered evaluation. person_role is the identity requirement that must be
    // positively verified. Context requirements (location, company type,
    // industry, size) tolerate "unknown" because search snippets routinely
    // omit them; unknown context demotes to qualified_partial instead of
    // discarding a verified decision-maker.
    let identityFails = 0,
      identityPasses = 0;
    let contextFails = 0,
      contextPasses = 0;
    let signalPasses = 0;
    let fabricatedHardPass = false;
    let uncitedIdentityPass = false;

    let identityHardTotal = profileHardReqs.filter(
      (req) => req.scope === "person_role",
    ).length;
    let contextHardTotal = profileHardReqs.length - identityHardTotal;

    const anyOfGroups = new Map<string, ProspectRequirement[]>();
    const ungroupedHardReqs: ProspectRequirement[] = [];

    for (const contractReq of profileHardReqs) {
      if (contractReq.groupId && contractReq.matchRule === 'any_of') {
        const list = anyOfGroups.get(contractReq.groupId) || [];
        list.push(contractReq);
        anyOfGroups.set(contractReq.groupId, list);
      } else {
        ungroupedHardReqs.push(contractReq);
      }
    }

    let groupIdentityTotal = 0;
    let groupContextTotal = 0;
    for (const [_, groupReqs] of anyOfGroups) {
      const isIdentityGroup = groupReqs.some(r => r.scope === 'person_role');
      if (isIdentityGroup) groupIdentityTotal++;
      else groupContextTotal++;
    }

    identityHardTotal = ungroupedHardReqs.filter(r => r.scope === 'person_role').length + groupIdentityTotal;
    contextHardTotal = ungroupedHardReqs.filter(r => r.scope !== 'person_role').length + groupContextTotal;

    const ablatedReqId = candidate.lead?._ablatedRequirementId;
    for (const contractReq of ungroupedHardReqs) {
      if (ablatedReqId && contractReq.id === ablatedReqId) {
        continue;
      }
      const req = requirements.find(r => r.requirementId === contractReq.id);
      if (!req) continue;
      if (req.fabricatedPass) fabricatedHardPass = true;
      const isIdentity = contractReq.scope === 'person_role';
      const rawReq = assessmentById.get(contractReq.id) as any;
      const rawClaimedPass = typeof rawReq?.status === 'string' && ['pass', 'qualified', 'passed'].includes(rawReq.status.trim().toLowerCase());
      if (isIdentity && rawClaimedPass && req.status === 'unknown' && !req.fabricatedPass) {
        uncitedIdentityPass = true;
      }
      if (req.status === 'pass') {
        if (isIdentity) identityPasses++;
        else contextPasses++;
      } else if (req.status === 'fail') {
        if (isIdentity) identityFails++;
        else contextFails++;
      }
    }

    for (const [_, groupReqs] of anyOfGroups) {
      const isIdentityGroup = groupReqs.some(r => r.scope === 'person_role');
      const groupAssessments = groupReqs.map(gr => requirements.find(r => r.requirementId === gr.id)).filter(Boolean);
      if (groupAssessments.some(a => a?.fabricatedPass)) fabricatedHardPass = true;
      if (isIdentityGroup) {
        for (const gr of groupReqs) {
          const rawReq = assessmentById.get(gr.id) as any;
          const rawClaimedPass = typeof rawReq?.status === 'string' && ['pass', 'qualified', 'passed'].includes(rawReq.status.trim().toLowerCase());
          const normReq = requirements.find(r => r.requirementId === gr.id);
          if (rawClaimedPass && normReq?.status === 'unknown' && !normReq?.fabricatedPass) {
            uncitedIdentityPass = true;
          }
        }
      }

      const anyPass = groupAssessments.some(a => a?.status === 'pass');
      const allFail = groupAssessments.length > 0 && groupAssessments.every(a => a?.status === 'fail');

      if (anyPass) {
        if (isIdentityGroup) identityPasses++;
        else contextPasses++;
      } else if (allFail) {
        if (isIdentityGroup) identityFails++;
        else contextFails++;
      }
    }

    for (const contractReq of signalHardReqs) {
      const req = requirements.find(r => r.requirementId === contractReq.id);
      if (req?.fabricatedPass) fabricatedHardPass = true;
      if (req?.status === 'pass') signalPasses++;
    }

    const rawSemantic = Number(judgment.semanticFit);
    const rawAuthority = Number(judgment.authorityFit);
    const rawEvidence = Number(judgment.evidenceConfidence);
    const scoresOmitted =
      !Number.isFinite(rawSemantic) ||
      !Number.isFinite(rawAuthority) ||
      !Number.isFinite(rawEvidence);

    const semanticFit = normalizeScoreTo10(judgment.semanticFit, 5);
    const authorityFit = normalizeScoreTo10(judgment.authorityFit, 5);
    const evidenceConfidence = normalizeScoreTo10(
      judgment.evidenceConfidence,
      5,
    );
    const reason =
      clean(judgment.reason, 500) ||
      "Matches the prospect contract with cited public evidence.";

    const identityVerified =
      identityFails === 0 && identityPasses === identityHardTotal;
    const contextVerified =
      contextFails === 0 && contextPasses === contextHardTotal;
    const signalsSatisfied =
      signalHardReqs.length === 0 || signalPasses === signalHardReqs.length;
    // When evidence packets are too thin to verify identity outright, the
    // judge's graded scores still carry decision weight instead of being
    // discarded: strong semantic + authority ratings qualify as partial.
    // However, in strict mode an uncited identity "pass" degrades to unknown
    // and is not rescued by graded scores alone.
    const stronglyRatedIdentity =
      !uncitedIdentityPass &&
      semanticFit >= 6.5 &&
      authorityFit >= (contract.authorityRequired ? 7.5 : 7.0);

    let status: FinalistOutcomeStatus = "unknown";
    if (identityFails > 0 || contextFails > 0) {
      // Any failed hard requirement (identity, company type, location, or industry) is a hard fail.
      status = "hard_fail";
      counts.hardFail++;
    } else if (fabricatedHardPass) {
      // A "pass" whose cited quote does not exist in the evidence packet is a
      // fabrication signal; it blocks qualification entirely.
      status = "unknown";
      counts.unknown++;
    } else if (identityVerified && contextVerified && signalsSatisfied) {
      status = "qualified";
      counts.qualified++;
    } else if (
      identityVerified ||
      (identityFails === 0 && stronglyRatedIdentity)
    ) {
      // Identity verified (or strongly rated); context attributes or dynamic
      // signals are uncorroborated (unknown) but the candidate is genuine.
      status = "qualified_partial";
      counts.qualified++;
    } else {
      status = "unknown";
      counts.unknown++;
    }

    if (status === "qualified" || status === "qualified_partial") {
      const corroboration = normalizeScoreTo10(
        candidate.lead.scout?.corroborationScore ??
          (candidate.evidence.length > 1 ? 7 : 4),
        5,
      );
      const weighted = contract.authorityRequired
        ? semanticFit * 0.5 +
          evidenceConfidence * 0.25 +
          authorityFit * 0.15 +
          corroboration * 0.1
        : semanticFit * 0.65 + evidenceConfidence * 0.25 + corroboration * 0.1;

      // Partial qualification applies a modest 15% discount because dynamic signal was not corroborated
      const scoreMultiplier = status === "qualified_partial" ? 0.85 : 1.0;
      const finalScore = Number((weighted * scoreMultiplier).toFixed(2));

      const qual: Qualification = {
        policyVersion: contract.policyVersion,
        verdict: status,
        qualificationSource: "llm",
        finalScore,
        requirements,
        reason:
          status === "qualified_partial"
            ? `${reason} (Decision maker verified; signal requirement uncorroborated)`
            : reason,
        semanticFit,
        evidenceConfidence,
        authorityFit,
        scoresOmitted,
      };
      candidate.lead.scoresOmitted = scoresOmitted;
      qualifications.set(candidate.candidateId, qual);
      outcomes.set(candidate.candidateId, {
        candidateId,
        status,
        qualification: qual,
        requirements,
        reason: qual.reason,
      });
    } else {
      outcomes.set(candidate.candidateId, {
        candidateId,
        status,
        requirements,
        reason,
      });
    }
  }

  counts.unjudged = candidates.length - validJudgmentCount;

  return {
    qualifications,
    outcomes,
    validJudgmentCount,
    expectedJudgmentCount: candidates.length,
    counts,
  };
}

export function finalistCandidateFromLead(
  candidateId: string,
  lead: Record<string, any>,
  evidenceText?: string,
  contract?: ProspectContract,
): FinalistCandidate {
  if (contract) {
    const selected = selectEvidenceForFinalist(lead, contract, evidenceText);
    return { candidateId, lead, evidence: selected.evidence };
  }
  const snippets = Array.isArray(lead.evidence?.snippets)
    ? lead.evidence.snippets
    : [];
  const structuredEvidence = `Name: ${lead.fullName || ""}\nTitle: ${lead.currentTitle || lead.headline || ""}\nCompany: ${lead.currentCompany || ""}\nLocation: ${lead.location || ""}\nHeadline: ${lead.headline || ""}`;
  const evidence = [
    { id: "e0", text: clean(structuredEvidence, 400) },
    evidenceText ||
      lead.evidence?.evidenceBlock ||
      lead.evidence?.rawText ||
      lead.evidence?.summary ||
      lead.summary ||
      "",
    ...snippets,
  ]
    .filter(
      (item) => item && (typeof item === "string" ? item.trim() : item.text),
    )
    .map((item, index) => {
      const text = typeof item === "string" ? item : item.text;
      return { id: `e${index}`, text: clean(text, 1400) };
    });
  return {
    candidateId,
    lead,
    evidence: evidence.length
      ? evidence
      : [{ id: "e1", text: "No supporting evidence was retrieved." }],
  };
}

export type DeterministicFinalist = {
  candidate: FinalistCandidate;
  qualification: Qualification;
};

/**
 * Fast-path only direct, typed profile matches. This intentionally avoids the
 * broader diagnostic matcher: it never treats a related role, city, or company
 * phrase as an equivalent one. Ambiguity always reaches the semantic judge.
 */
export function partitionCandidatesByStrictEvidence(
  candidates: FinalistCandidate[],
  contract: ProspectContract,
): { autoQualified: DeterministicFinalist[]; needsJudge: FinalistCandidate[] } {
  // Auto-qualify gate uses only structured_profile hard requirements.
  // Signal requirements (open_web_signal) are always passed to the semantic judge.
  const hardRequirements = contract.requirements.filter(
    (requirement) =>
      requirement.importance === "hard" &&
      (requirement.evidenceModality ||
        (requirement.scope === "signal"
          ? "open_web_signal"
          : "structured_profile")) !== "open_web_signal",
  );
  const hasOpenWebSignalHardReqs = contract.requirements.some(
    (r) =>
      r.importance === "hard" &&
      (r.evidenceModality ||
        (r.scope === "signal" ? "open_web_signal" : "structured_profile")) ===
        "open_web_signal",
  );

  const autoQualified: DeterministicFinalist[] = [];
  const needsJudge: FinalistCandidate[] = [];

  for (const candidate of candidates) {
    // If there are open_web_signal hard requirements, always send to the judge so signals are evaluated
    if (
      hasOpenWebSignalHardReqs ||
      !hardRequirements.length ||
      Boolean(candidate.lead._ablatedRequirementId) ||
      !hardRequirements.every((requirement) =>
        hasStrictStructuredMatch(candidate.lead, requirement),
      )
    ) {
      needsJudge.push(candidate);
      continue;
    }

    const requirements: RequirementAssessment[] = contract.requirements.map(
      (requirement) => ({
        requirementId: requirement.id,
        status: requirement.importance === "hard" ? "pass" : "unknown",
        evidenceId: requirement.importance === "hard" ? "e0" : undefined,
      }),
    );
    const authorityFit = contract.authorityRequired
      ? normalizeScoreTo10(
          candidate.lead.decisionMakerVerification?.confidence ??
            candidate.lead.audit?.authorityConfidence ??
            5,
          5,
        )
      : 0;
    const evidenceConfidence = normalizeScoreTo10(
      candidate.lead.scout?.evidenceCoverageScore ??
        candidate.lead.scoreBreakdown?.evidenceQualityScore ??
        5,
      5,
    );
    autoQualified.push({
      candidate,
      qualification: {
        policyVersion: contract.policyVersion,
        verdict: "qualified",
        qualificationSource: "deterministic",
        // Use the same selection scorer as non-qualified/rescued leads instead
        // of inventing a founder/owner-specific or arbitrary score cap.
        finalScore: rankLeadForFinalSelection(candidate.lead),
        requirements,
        reason:
          "Direct structured profile fields satisfy every hard requirement; no semantic inference was needed.",
        semanticFit: 10,
        evidenceConfidence,
        authorityFit,
      },
    });
  }

  return { autoQualified, needsJudge };
}

export type TriPartitionResult = {
  autoQualified: DeterministicFinalist[];
  autoFailed: Array<{
    candidate: FinalistCandidate;
    reason: string;
    failedRequirementId: string;
  }>;
  needsJudge: FinalistCandidate[];
};

export function checkStrictContradiction(
  lead: Record<string, any>,
  contract: ProspectContract,
): { reason: string; requirementId: string } | null {
  const candidateText = `${lead.currentTitle || ""} ${lead.headline || ""} ${lead.currentCompany || lead.company || ""} ${lead.summary || ""}`.toLowerCase();
  const hasStrictAgencyNoun = /\b(agenc(?:y|ies)|consultan(?:cy|cies)|studios?|firms?|boutique)\b/i.test(candidateText);
  const isAgencyContractOrBrief =
    isAgencyContract(contract) ||
    /\b(agenc(?:y|ies)?|consult(?:an(?:cy|cies|t|ts)|ing)?|studios?|firms?|integrat(?:or|ors)?|client\s+services?)\b/i.test(contract.brief) ||
    contract.requirements.some(
      (r) =>
        (r.scope === "company_type" || r.scope === "company_industry") &&
        /\b(agenc(?:y|ies)?|consult(?:an(?:cy|cies|t|ts)|ing)?|studios?|firms?|integrat(?:or|ors)?)\b/i.test(`${r.description} ${r.acceptableTerms?.join(" ") || ""}`),
    );
  const isBusinessOwnerQuery =
    contract.requirements.some(
      (r) =>
        r.scope === "person_role" &&
        /\b(owners?|founders?|co-?founders?|proprietors?|managing\s+partners?)\b/i.test(
          `${r.description} ${r.acceptableTerms?.join(" ") || ""}`,
        ),
    ) ||
    /\b(owners?|founders?|co-?founders?|proprietors?|managing\s+partners?)\b/i.test(contract.brief);
  const isOwnerOrFounderQuery =
    isBusinessOwnerQuery ||
    contract.requirements.some(
      (r) =>
        r.scope === "person_role" &&
        /\b(ceo|chief executive|proprietor|(?<!vice\s+|vice-)president)\b/i.test(
          `${r.description} ${r.acceptableTerms?.join(" ") || ""}`,
        ),
    ) ||
    /\b(ceo|chief executive|proprietor|(?<!vice\s+|vice-)president)\b/i.test(contract.brief);

  // 0. Company page saved as a person (dataset dossiers return company
  // profiles with first_name/last_name reconstituting the brand, e.g.
  // fullName "Verdeschi Realty" at company "Verdeschi Realty").
  if (
    isCompanyPageProfile({
      fullName: lead.fullName || lead.profile?.fullName,
      company:
        lead.currentCompany || lead.company || lead.profile?.currentCompany,
    })
  ) {
    return {
      reason: `Company page saved as a person ('${clean(lead.fullName || lead.profile?.fullName || "", 100)}' equals the company name)`,
      requirementId: "person_role",
    };
  }

  // 1. Explicit Exclusions Check
  const hasFounderOrOwnerLeadership = /\b(owners?|founders?|co-?founders?|ceo|chief executive|managing partner|proprietor|(?<!vice\s+|vice-)president)\b/i.test(
    clean(lead.currentTitle || lead.headline || "", 200),
  );
  for (const exclusion of contract.exclusions || []) {
    const term = clean(exclusion, 100).toLowerCase();
    if (!term || term.length < 2 || term.startsWith('-')) continue;
    const isIcRoleTerm = /\b(staff\s+engineer|principal\s+engineer|principal\s+product\s+manager|product\s+manager|senior\s+software\s+engineer)\b/i.test(term);
    if (isIcRoleTerm && hasFounderOrOwnerLeadership) {
      continue;
    }
    const isProductTerm = /\b(saas|software\s+product|software\s+platform|consumer\s+app|mobile\s+app)\b/i.test(term);
    if (isProductTerm && (hasStrictAgencyNoun || (hasFounderOrOwnerLeadership && isAgencyContractOrBrief))) {
      // An agency serving SaaS or providing software services is client-services, not a pure product firm
      continue;
    }
    const title = clean(lead.currentTitle || lead.headline || "", 200).toLowerCase();
    const company = clean(lead.currentCompany || lead.company || "", 200).toLowerCase();
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const termRegex = new RegExp(`(^|\\W)${escapedTerm}($|\\W)`, 'i');
    if (termRegex.test(title) || termRegex.test(company)) {
      return {
        reason: `Matches contract exclusion: '${exclusion}'`,
        requirementId: "exclusion",
      };
    }
  }

  // 2. Strict Negative Seniority Check (when authorityRequired = true)
  if (contract.authorityRequired) {
    const dm = lead.decisionMakerVerification;
    const gate = evaluateDecisionMakerGate({
      ignoredTitle: dm?.ignoredTitle,
      confidence: dm?.confidence,
      authorityRequired: true,
    });
    if (!gate.pass) {
      return {
        reason: gate.reason || `Explicit non-decision maker or entry-level role: ${dm?.reason || "low authority"}`,
        requirementId: "authority",
      };
    }
    // Ghost-profile floor: an explicitly zero follower count on a tiny
    // network is a brand-new, fake, or company-page profile. Unknown counts
    // (null) never fail -- only measured zeros do.
    const socialProof = extractSocialProof(lead);
    if (isGhostProfile(socialProof)) {
      return {
        reason: `Ghost profile: 0 followers with ${socialProof.connections ?? 0} connections`,
        requirementId: "authority",
      };
    }
  }

  // 3. Mandatory Company Verification
  const isBusinessOwnerOrAgencyContract = isAgencyContractOrBrief || isBusinessOwnerQuery;
  const companyHardReq = contract.requirements.find(
    (r) => (r.scope === "company_type" || r.scope === "company_industry") && r.importance === "hard",
  );
  if (isBusinessOwnerOrAgencyContract && companyHardReq) {
    const rawCompany = clean(
      lead.currentCompany || lead.company || lead.profile?.currentCompany || lead.organization || "",
      200,
    );
    const isEntityVerified = Boolean(
      lead.companyEntityResolution?.verified && lead.companyEntityResolution?.companyName,
    );
    if (!rawCompany && !isEntityVerified) {
      return {
        reason: `Candidate has no verified company or organization for hard requirement '${companyHardReq.description}'`,
        requirementId: companyHardReq.id,
      };
    }
  }

  // 4. Deterministic Anti-Personas: Big-Tech Non-Agency Employers
  const BIG_TECH_REGEX =
    /\b(microsoft|google|meta|apple|amazon|openai|netflix|nvidia|bytedance|salesforce|oracle|uber|airbnb|stripe|palantir|cisco|adobe|intel|ibm|deepmind|github|instagram|whatsapp|aws|azure|youtube)\b/i;

  if (isAgencyContractOrBrief) {
    const rawCompany = clean(
      lead.currentCompany || lead.company || lead.profile?.currentCompany || lead.organization || "",
      200,
    ).toLowerCase();
    const rawTitle = clean(lead.currentTitle || lead.jobTitle || lead.headline || "", 200).toLowerCase();

    const bigTechCompanyMatch = rawCompany.match(BIG_TECH_REGEX);
    const bigTechTitleMatch = rawTitle.match(/(?:@|at|\bin\b|[-|,]\s*)\s*(microsoft|google|meta|apple|amazon|openai|netflix|nvidia|bytedance|salesforce|oracle|uber|airbnb|stripe|palantir|cisco|adobe|intel|ibm|deepmind|github|instagram|whatsapp|aws|azure|youtube)\b/i);
    const matchedBigTech = bigTechCompanyMatch?.[1] || bigTechTitleMatch?.[1];

    if (matchedBigTech) {
      return {
        reason: `Candidate is employed by non-agency tech enterprise: '${matchedBigTech}'`,
        requirementId: companyHardReq ? companyHardReq.id : "company_type",
      };
    }
  }

  // 4b. Wrong-vertical agency check: bare "agency" also matches real estate,
  // insurance, cannabis retail, and travel agencies. Fail those unless the
  // contract names the vertical (a brief asking for real estate agencies
  // must still match). Mirrors the Big Tech pattern above.
  // 4b. Wrong-vertical check by cluster:
  // Bare "agency" also matches real estate/insurance/cannabis, "coaching" matches therapy/fitness coach, etc.
  // Fail those unless the contract names the vertical (a brief asking for real estate agencies must still match).
  const domainCluster = deriveDomainCluster(contract.brief || "");
  const targetCluster = domainCluster !== 'global' ? domainCluster : (isAgencyContractOrBrief ? 'b2b_agency' : '');
  const wrongVerticalRegex = targetCluster ? getWrongVerticalRegexForCluster(targetCluster) : null;
  if (wrongVerticalRegex) {
    const contractText = `${contract.brief || ""} ${(contract.requirements || [])
      .filter((r) => r.scope === "company_type" || r.scope === "company_industry")
      .map((r) => `${r.description} ${(r.acceptableTerms || []).join(" ")}`)
      .join(" ")}`;
    if (!contractMentionsVertical(contractText, wrongVerticalRegex)) {
      // G10: company-scoped for b2b_saas so past-career prose never auto-fails.
      const verticalHit = candidateMatchesWrongVertical(lead, wrongVerticalRegex, targetCluster);
      if (verticalHit) {
        return {
          reason: targetCluster === 'b2b_agency'
            ? `Candidate operates a non-services '${verticalHit}' agency, not a client-services firm`
            : `Candidate operates in excluded vertical '${verticalHit}' for domain '${targetCluster}'`,
          requirementId: companyHardReq ? companyHardReq.id : "company_type",
        };
      }
    }
  }

  // 5. Deterministic Anti-Personas: IC Roles (Staff/Principal Engineer, Product Manager)
  if (isOwnerOrFounderQuery) {
    const rawTitle = clean(lead.currentTitle || lead.jobTitle || lead.headline || "", 200);
    const classification = classifyTitle(rawTitle);

    if (classification.isIC) {
      return {
        reason: `Individual contributor role ('${lead.currentTitle || lead.headline}') contradicts required owner/founder leadership`,
        requirementId: "authority",
      };
    }
  }

  // 6. Hard Seam: Client Services / Agencies vs Software Products
  if (isAgencyContractOrBrief) {
    const hasExplicitProductApp = /\b(mobile app|ios app|android app|b2c app|personal trainer app|habit tracker|consumer app|saas platform|software product)\b/i.test(candidateText);
    if (hasExplicitProductApp && !hasStrictAgencyNoun) {
      return {
        reason: `Candidate operates a software product/app rather than a client services agency`,
        requirementId: companyHardReq ? companyHardReq.id : "company_type",
      };
    }
  }

  // 7. Strict Monotonic Location Contradiction
  const locReq = contract.requirements.find(
    (r) => r.scope === "person_location" && r.importance === "hard",
  );
  if (locReq && locReq.acceptableTerms?.length) {
    const rawLoc = clean(`${lead.location || ""} ${lead.profile?.location || ""}`, 300).toLowerCase();
    if (rawLoc.trim().length > 0) {
      const acceptable = locReq.acceptableTerms.map((t) => t.toLowerCase());
      const hasAnyAcceptable = acceptable.some((term) => rawLoc.includes(term));
      const hasRemoteTag = /\b(remote|telecommute|worldwide|global|anywhere)\b/i.test(rawLoc);

      // Explicit contradiction ONLY if candidate explicitly states a foreign country
      // AND has ZERO target terms AND NO remote indicators:
      const hasForeignCountry = /\b(india|united kingdom|uk|england|scotland|london|australia|germany|france|netherlands|brazil|nigeria|philippines|pakistan)\b/i.test(rawLoc);
      const isTargetUS = acceptable.some((t) => ["us", "usa", "united states", "america"].includes(t));

      if (isTargetUS && hasForeignCountry && !hasAnyAcceptable && !hasRemoteTag) {
        return {
          reason: `Location '${rawLoc}' explicitly contradicts target '${locReq.acceptableTerms.join(", ")}'`,
          requirementId: locReq.id,
        };
      }
    }
  }

  return null;
}

export function triPartitionCandidatesByEvidence(
  candidates: FinalistCandidate[],
  contract: ProspectContract,
): TriPartitionResult {
  const hardRequirements = contract.requirements.filter(
    (requirement) =>
      requirement.importance === "hard" &&
      (requirement.evidenceModality ||
        (requirement.scope === "signal"
          ? "open_web_signal"
          : "structured_profile")) !== "open_web_signal",
  );
  const hasOpenWebSignalHardReqs = contract.requirements.some(
    (r) =>
      r.importance === "hard" &&
      (r.evidenceModality ||
        (r.scope === "signal" ? "open_web_signal" : "structured_profile")) ===
        "open_web_signal",
  );

  const autoQualified: DeterministicFinalist[] = [];
  const autoFailed: TriPartitionResult["autoFailed"] = [];
  const needsJudge: FinalistCandidate[] = [];

  for (const candidate of candidates) {
    const { lead } = candidate;

    // 1. Check Explicit Contradictions (Auto-Fail Gate)
    const contradiction = checkStrictContradiction(lead, contract);
    if (contradiction) {
      autoFailed.push({
        candidate,
        reason: contradiction.reason,
        failedRequirementId: contradiction.requirementId,
      });
      continue;
    }

    // 2. Check Strict Positive Matches (Auto-Pass Gate)
    const matchesAllStructured =
      hardRequirements.length > 0 &&
      !Boolean(lead._ablatedRequirementId) &&
      hardRequirements.every((requirement) =>
        hasStrictStructuredMatch(lead, requirement),
      );

    if (!matchesAllStructured) {
      // G2 telemetry: routed to judge because location is company-derived.
      const prov = (lead as any)?._locationProvenance || (lead as any)?.profile?._locationProvenance;
      if (prov === 'company_site' && hardRequirements.some(r => r.scope === 'person_location')) {
        judgeEvidenceTelemetry.companyDerivedLocationAutoPasses++;
      }
      needsJudge.push(candidate);
      continue;
    }

    // Candidate strictly satisfies every structured hard requirement (role, company, location).
    // Now evaluate open-web signal requirements (both hard and soft) against signalTexts:
    const signalTexts = [
      ...(candidate.evidence || []).map((e) => e?.text || ""),
      lead.evidence?.evidenceBlock || "",
      ...(Array.isArray(lead.evidence?.snippets)
        ? lead.evidence.snippets.map((s: any) =>
            typeof s === "string" ? s : s?.text || "",
          )
        : []),
      lead.companyIntentEvidence?.snippets?.join(" ") || "",
    ]
      .join(" ")
      .toLowerCase();

    let hasSignalCorroboration = false;
    if (hasOpenWebSignalHardReqs) {
      const signalReqs = contract.requirements.filter(
        (r) =>
          r.importance === "hard" &&
          (r.evidenceModality ||
            (r.scope === "signal" ? "open_web_signal" : "structured_profile")) ===
            "open_web_signal",
      );
      hasSignalCorroboration = signalReqs.every((sReq) =>
        (sReq.acceptableTerms || []).some((term) =>
          aliasIncludes(signalTexts, term),
        ),
      );
    }

    const verdict: "qualified" | "qualified_partial" =
      hasOpenWebSignalHardReqs && !hasSignalCorroboration
        ? "qualified_partial"
        : "qualified";

    const requirements: RequirementAssessment[] = contract.requirements.map(
      (requirement) => {
        if (requirement.importance !== "hard") {
          const softMatched = (requirement.acceptableTerms || []).some((term) =>
            aliasIncludes(signalTexts, term),
          );
          const softStatus: RequirementStatus = softMatched ? "pass" : "unknown";
          return {
            requirementId: requirement.id,
            status: softStatus,
            evidenceId: softStatus === "pass" ? "e0" : undefined,
          };
        }
        const isSignal =
          (requirement.evidenceModality ||
            (requirement.scope === "signal"
              ? "open_web_signal"
              : "structured_profile")) === "open_web_signal";
        const status: RequirementStatus = isSignal
          ? hasSignalCorroboration
            ? "pass"
            : "unknown"
          : "pass";
        return {
          requirementId: requirement.id,
          status,
          evidenceId: status === "pass" ? "e0" : undefined,
        };
      },
    );
    const authorityFit = contract.authorityRequired
      ? normalizeScoreTo10(
          lead.decisionMakerVerification?.confidence ??
            lead.audit?.authorityConfidence ??
            5,
          5,
        )
      : 0;
    const evidenceConfidence = normalizeScoreTo10(
      lead.scout?.evidenceCoverageScore ??
        lead.scoreBreakdown?.evidenceQualityScore ??
        5,
      5,
    );
    autoQualified.push({
      candidate,
      qualification: {
        policyVersion: contract.policyVersion,
        verdict,
        qualificationSource: "deterministic",
        finalScore: rankLeadForFinalSelection(lead),
        requirements,
        reason:
          verdict === "qualified"
            ? "Direct structured profile fields satisfy every hard requirement; no semantic inference was needed."
            : "Direct structured profile fields satisfy core identity requirements; open-web buying signal is uncorroborated in initial profile snippet.",
        semanticFit: verdict === "qualified" ? 10 : 8,
        evidenceConfidence,
        authorityFit,
      },
    });
  }

  return { autoQualified, autoFailed, needsJudge };
}
