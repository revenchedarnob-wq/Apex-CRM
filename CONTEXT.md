# Apex CRM Domain Glossary

This document defines the core domain language used throughout the Apex CRM codebase.

---

### Discovery Session
A bounded execution run that locates, evaluates, enriches, and qualifies prospects matching a user's natural language prospecting brief.

### Prospect Contract
A deterministic or LLM-compiled specification derived from a prospecting brief. It defines strict hard requirements, soft signals, modality types, acceptable terms, and the decomposition mode.

### Identity Plane (Stream A)
The discovery dimension focused exclusively on persona and firmographic coordinates: job titles/roles, company types/names, and geographic locations. Used to generate high-recall LinkedIn profile queries.

### Intent Plane (Stream B)
The research dimension focused on real-world buying signals, hiring triggers, active tooling usage, and operational pain points on the open web, company websites, and LinkedIn post activity.

### Candidate Lead
An unverified or raw public profile observation discovered from web retrieval before formal evaluation.

### Qualified Prospect
A candidate that has satisfied all required contract criteria and decision-maker checks, backed by cited proof snippets.

### Finalist Judge
A multi-tier evaluation system that verifies candidate evidence against contract requirements using fast-path exact checks or bounded LLM judging.

### Pareto Frontier (Skyline)
A non-dominated subset of candidate leads that excel across multi-objective dimensions (authority, fit, intent, and evidence quality), reserved to prevent dilution by single-metric scoring.

### Reverse Flywheel
The feedback loop where open-web signal searches discover active hiring/tooling accounts, and dynamically generate targeted executive profile queries for decision-makers at those specific accounts.

### Domain-Clustered Multi-Armed Bandit (MAB)
A contextual Thompson-sampling and UCB scheduler that ranks and throttles query plan arms (`family|lane|provider`) partitioned by business domain cluster (e.g. `b2b_agency`, `b2b_saas`, `executive_coaching`) with exponential moving average time decay ($\lambda = 0.95$), binary outcome rate boosting (`lead_outcomes`), and explicit penalties for hard-failed candidates.

### Dynamic Semantic Query Expansion
A non-colliding fallback query planner that synthesizes multi-attribute candidate search queries using domain synonyms, tooling keywords, and pain signals from the prospect contract rather than rigid Cartesian permutation loops.

### Career Trajectory Discounted Cumulative Relevance (DCR)
An exponential recency decay and domain authority scoring model that evaluates past and current leadership roles across modern executive titles (Founders, C-Suite, Fractional CXOs, Practice Leads, RevOps/GTM Heads, and Principal Consultants).

### Site Probe Buying Signal Extraction
A multi-tier extraction engine that inspects target company root websites and deep subpaths (`/about`, `/team`, `/pricing`, `/case-studies`, `/careers`) to extract high-fidelity commercial signals (pricing models, customer case studies, tech stack badges, and active hiring roles).

### Global Corporate Entity Resolution
An alias-matching and normalization system that strips global corporate entity forms (`S.R.L.`, `S.A.S.`, `S.L.`, `AG`, `Pte Ltd`, `Sdn Bhd`, `Sp. z o.o.`, `ApS`, `Pty Ltd`) and regional branch designations (`EMEA`, `APAC`, `Global`, `Holdings`) to prevent company profile duplicates.

### Lean Adaptive Collection Capacity
A dynamic candidate sizing policy that sets search pool targets proportional to requested output limits (1.15x-1.25x cushion) with dynamic batch scaling (15-40 leads/round). Round budgets are derived by target size (default cap of 3 rounds for targets up to 30, 4 up to 50, 6 above), bounded by a hard ceiling of `MAX_COLLECTION_ROUNDS = 24`, and overridden by `LEAD_SEARCH_MAX_ROUNDS` when that is set (6 in the shipped configuration).

### Decoupled Early Shortlist Termination
A high-selectivity discovery exit check that terminates search rounds immediately when verified candidate volume satisfies target limits, decoupled from literal keyword substring heuristics.

### Targeted Post-Selection Enrichment
A pipeline execution order that defers intensive Phase 4 company website probing and Phase 5 LinkedIn post intent SERP lookups until after the Finalist Judge and Pareto diversification have selected the top $K$ prospect finalists.

### Deterministic Pre-Filter Gate (Stage 2.5)
A zero-latency, non-LLM filtration boundary positioned immediately after SERP retrieval and observation fusion. It drops known CRM duplicates (via SQLite identity keys in 0ms), filters out non-LinkedIn items when individual profiles are required, strips HTML boilerplate and cookie banners from snippets, and safely bypasses the extraction LLM when zero viable items remain.

### Upstream CRM Negative Feedback & Metro Saturation Avoidance
A closed-loop query optimization mechanism that extracts existing company domains from the CRM database and injects them directly into Tavily's `exclude_domains` parameter. It also monitors metropolitan saturation ($\ge 15$ leads in CRM, including JSON-extracted `profile.location` and `profile.city` fields) and seeds cross-session `discovered_companies` to steer query generation toward unmined secondary tech clusters while equipping the LLM strategist with negative search operators (`-"Known Agency"`).

### Consolidated Site Probing
Target company website inspection is consolidated in `enrichStage` (following Pareto candidate selection) with normalized bare-host caching. In ~250ms per company, it fetches root page meta description or title to inject verified business context and commercial signals into candidate profiles without duplicate network calls.

### Deterministic Role Triage
An instant 0ms pre-judge classification that identifies and discards individual contributors (`intern`, `staff engineer`, `ml engineer`, `data scientist`, `recruiter`, `account executive`) from finalist judging when the contract strictly demands executive, founder, or partner-level decision makers. Title acronyms (`MD`, `VP`, `CTO`, `CRO`) are expanded to canonical forms before matching so abbreviated executive titles are not mis-triaged.

### Strict Sequential LLM Invariant (`withSequentialLLMExecution`)
The core concurrency invariant governing all LLM interactions in the discovery engine. By default all completion calls across strategist, extraction, verification, and judging stages are serialized through a single execution queue to prevent rate limit collisions, gateway thread starvation, and upstream provider 429/524 errors. Behind `FEATURE_LLM_STAGE_QUEUES=true` the queue shards into independent stage lanes (`strategist | extraction | judge | general`, max 2 each, global cap 4) with per-provider 429/524 backoff preserved.

### Query Understanding Layer (`queryUnderstanding.ts`)
A deterministic complexity classifier that labels each brief `vague | standard | rich` with an ambiguity score and missing-slot list (`role`, `geo`, `industry`, `seniority`, `signal`). It drives vagueness-aware retrieval depth, task sizing, and the interactive (`needs_clarification`) vs headless (expander fallback) clarification gate. Long briefs are salience-compressed before prompt injection instead of mid-phrase truncation.

### Zero Default-Invention Rule (`resolveGeo`)
When a brief specifies no geography, the engine returns `geo=open_global` with no `countryAnchor` and no metro hubs. Two-character ISO country codes colliding with English pronouns or prepositions (`us`, `me`, `am`, `in`, `is`, `at`, etc.) require explicit prepositional context, uppercase casing, or metro cues before anchoring geography. City-only geographies (`London`, `Berlin`) resolve to their parent country and metro anchor without allowing the vertical slot to equal the location.

### Alias-First Matching (`aliasMap.ts`)
A zero-network, synchronous normalization map (roles, ISO geographies/regions, company types, tools) used in hot loops (`fuseStage`, `evidenceSelection`, `finalistJudge`) and contract grounding (`sourceAppearsInBrief`). `aliasIncludes` performs symmetrical bidirectional token and phrase normalization (`MD` <-> `managing director`, `US` <-> `united states`, `CEO` <-> `chief executive officer`, `UK` <-> `united kingdom`) with 0ms latency, while contract role matchers accept plural persona forms (`CEOs`, `Presidents`, `VPs`) without leaking roles into `company_type`.

### Complexity-Aware Query Rewriter (`queryRewriter.ts`)
A bounded (max 3) zero-yield recovery policy that replaces single-retry ablation as the second chance: `vague` and `standard` briefs broaden by dropping low-signal tokens while skipping Tier-1 immutable identity anchors (`person_role`, `company_type`, `industry`), and `rich` briefs relax the lowest-salience covered non-Tier-1 hard requirement (preferring `person_location` before `company_type`). Rewritten queries dispatch on both credit-reservation and standard execution paths, threading `demotedRequirementId` into coverage tracking.

### Quantized Semantic Centroids (MAB)
The domain-clustered MAB pools Thompson-sampling priors by 24 persistent deterministic buckets (`centroid_<cluster>_<00-23>`, FNV-1a over the normalized brief) instead of raw embedding vectors, so repeated brief shapes converge instead of permanent cold-start. `contract_guard` tasks are treated as non-optional correctness constraints: only non-guard tasks are trimmed by the `maxTasks+2` cap, ensuring 100% hard-requirement coverage survives pruning.

### Contract-Aware Ranking (`rankLeadForFinalSelection`)
Final selection scoring takes the contract into account: hard-requirement coverage dominates with a `1.2x` spread and soft-signal coverage actively boosts (`0.4x`), replacing the previous hard-only rank where soft nuance was invisible.

### LLM Completion Cache (`llm_completion_cache`)
A durable, prompt-hash-keyed cache in front of the LLM gateway (`server/services/llm.ts`). Repeat completions (strategist rounds, identical extraction chunks) are served from SQLite instead of the provider, with per-entry `expires_at` TTL and periodic `purgeLlmCacheExpired` sweeps. It targets the dominant share of session wall clock previously lost to repeated LLM latency.

### Gated Company Attribution (`companyAttribution.ts`)
A bounded LLM attribution step that verifies a discovered company actually fits the brief before prospects are attributed to it. It classifies the company's business model (`client_services_agency`, `software_saas`, `e_commerce`, ...), checks query alignment (`matches_brief | adjacent | contradicts`), and emits `verified_fit | unverified | disqualifying_contradiction` verdicts grounded in a verbatim evidence quote. Business-model contradictions gate candidates out before judge tokens are spent.

### Deterministic Profile Quality Gates (`profileQuality.ts`)
Zero-LLM quality gates shared by dataset-dossier and SERP candidates: social-proof parsing (followers/connections/influencer), company-page and ghost-profile detection, and wrong-vertical agency detection. Single source of truth for `checkStrictContradiction` in the Finalist Judge (with `b2b_saas` contradictions scoped to company and industry fields so past-career bio mentions do not false-fail) so both candidate origins face identical gates at zero token cost.

### Strict Evidence Citation Grounding (`EVIDENCE_GROUNDING_MODE`)
The verification rule governing finalist judging (`strict` by default). Every LLM `pass` verdict on a contract requirement must cite a resolvable evidence passage whose quote matches via exact, alias-normalized, or polarity-guarded fuzzy matching (`0.7 * windowOverlap + 0.3 * setOverlap`, rejecting windows with stray negators such as `not`, `no`, `never`, `former`, `ex-`). Passes without grounded citations degrade to `unknown` (`fabricatedPass`), while explicit hard-requirement failures (`identityFails > 0 || contextFails > 0`) always take precedence as `hard_fail`.

### Location Provenance Separation (`_locationProvenance`)
The provenance boundary distinguishing a prospect's personal location from a company headquarters address scraped during website probing (`_locationProvenance = 'company_site'`). Company-derived locations are provided to the semantic judge as context but are excluded from `hasStrictStructuredMatch` for `person_location` hard requirements. Evidence-extracted URLs (`evidence_url`) must share a meaningful token with the company name before site probing to prevent press domains (e.g. TechCrunch) from being scraped as company sites.

### Annotate-Only Post-Intent Enrichment
The execution model for Phase 5 LinkedIn post SERP research (`linkedinPostIntent.ts`): enrichment annotates selected finalists in map order without re-sorting or cutting the finalist list. Snippet recency parsing supports both full and abbreviated markers (`2d ago`, `1w ago`, `3mo ago`, `1y ago`, `2h ago`), and undated snippets default to a neutral 45-day age (`UNKNOWN_AGE_DAYS = 45`) so undated text never receives a synthetic recency boost.

### CRM Workflow Field Preservation
The persistence rule in `upsertLeadInExistingTransaction` (`server/db.ts`) that protects human-managed CRM state (`stage`, `reviewStatus`, `nextAction`, `notes`) during engine re-persistence. When a discovery session re-encounters an existing lead, objective profile and score fields are refreshed while human workflow fields remain untouched unless `forceOverwrite: true` is explicitly supplied.

### Binary Outcome Feedback (`lead_outcomes`)
The closed-loop disposition table (schema v23) recording `positive` (`KEEP`, `VERIFIED`, `CONVERTED`, `CLOSED_WON`, `MEETING BOOKED`, `REPLIED`) and `negative` (`REJECT`, `REJECTED`, `LOST`, `UNQUALIFIED`) transitions. Outcome events update both the global outcome rate boost in `scoreAdaptiveArm` and cluster-scoped `query_performance` counters via top-level `discoveryFamily` and `discoveryLane` attribution.


### Business Lead (`kind: 'business'`)
A lead that is a business rather than a person, such as a small business found through its public Facebook Page (schema v24). Its structured facts live in `lead.business` (Page URL and id, category, address, phones, emails, websites, followers, rating, optional owner name with its source). For compatibility `profile.fullName` and `profile.currentCompany` hold the business name, so every existing view works unchanged. `leads.kind` and `leads.source` are promoted columns for filtering. Business leads also de-duplicate on Facebook Page id or username, website domain and phone number; those keys are never applied to people, because colleagues share a company website.
