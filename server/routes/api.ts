import { Router } from "express";
import crypto from "crypto";
import {
  LEAD_STAGE_SET as leadStages,
  REVIEW_STATUS_SET as reviewStatuses,
  NEXT_ACTION_SET as nextActions,
  LEAD_KIND_SET as leadKinds,
  LEAD_SOURCE_SET as leadSources,
} from "../../src/types.js";
import {
  readLeadsSummary,
  readLeadsStats,
  invalidateLeadsStatsCache,
  getLeadsETag,
  readLeadsStageSummary,
  readStoredLeadById,
  hasLeadStoreBeenInitialized,
  replaceStoredLeads,
  normalizeIncomingLeads,
  getLeadsDb,
  readSearchLogs,
  readSearchLogById,
  readMiningSessionById,
  readMiningSessionSummaryById,
  readMiningSessions,
  readMiningSessionCheckpoint,
  readMiningSessionTokenStats,
  readResumableMiningSessions,
  deleteMiningSession,
  deleteMiningSessions,
  clearResumableMiningSessions,
  upsertMiningSession,
  LeadNotFoundError,
  LeadRevisionConflictError,
  upsertLeadInExistingTransaction,
  upsertLeadWithIdentity,
  deleteLead,
  deleteLeadInExistingTransaction,
  upsertLeadsWithIdentity,
  transferLeadIdentities,
  insertLeadActivity,
  readLeadActivities,
  upsertOutreachDraft,
  readOutreachDrafts,
  readOutreachDraftsByLeadId,
  deleteOutreachDraft,
  readSavedSearches,
  getSavedSearchExcludeList,
  upsertSavedSearch,
  deleteSavedSearch,
  recordQueryPerformance,
  recordLeadOutcome,
  readProviderUsage,
  readEngineMetrics,
} from "../db.js";
import {
  hasOpenAIKey,
  hasTavilyKey,
  tavilySearch,
  openAIStructured,
  singleProfileSchema,
  APEX_SYSTEM_PROMPT,
  searchSpecSchema,
  openAIText,
  STRATEGIST_SYSTEM_PROMPT,
  getLLMProviderSummaries,
  getTavilyKeyStatus,
} from "../services/llm.js";
import { buildOutboundPrompt } from "../services/outboundPrompt.js";
import {
  closeBrightDataClient,
  getBrightDataStatus,
  getBrightDataCapabilities,
  isBrightDataConfigured,
} from "../services/brightdata.js";
import {
  buildFallbackQueryPlan as buildScoutFallbackQueryPlan,
  buildFallbackSearchSpec,
  buildRetrievalTasks,
  buildSearchSpecPrompt,
  normalizeSearchSpec,
  type DiscoveryMode,
} from "../leadSearch/searchSpec.js";
import {
  tavilyFreeTierCapabilities,
  isProviderCreditReservationEnabled,
} from "../leadSearch/freeTier.js";
import {
  resolveDiscoveryProviderMode,
  resolveBrightDataSearchMode,
} from "../leadSearch/discoveryRouting.js";
import { enrichLeadProfile } from "../leadSearch/profileEnrichment.js";
import { deriveDomainCluster } from "../leadSearch/adaptiveScheduler.js";
import {
  discoveryEngine,
  SessionAlreadyActiveError,
} from "../leadSearch/discoveryEngine.js";
import { sessionStreamHub } from "../services/sessionStreamHub.js";

const router = Router();

/**
 * Minimal fixed-window limiter for endpoints that spend money (LLM, Tavily, Bright Data).
 * This is a single-user local app, so the goal is not abuse prevention - it is to stop an
 * accidental retry loop (or any caller that gets past the host guard) from hammering paid
 * providers. Counts are per-route and in-memory, so they reset on restart.
 */
const paidRouteWindows = new Map<string, { count: number; resetAt: number }>();
// Default 120/min (2/sec sustained): generous for interactive and bulk use, but still far
// below a runaway retry loop, which fires at hundreds per second.
const paidRouteLimit = (routeKey: string, maxPerMinute = 120) => {
  const limit = Math.min(
    Math.max(Number(process.env.APEX_PAID_ROUTE_LIMIT_PER_MIN || maxPerMinute) || maxPerMinute, 1),
    600,
  );
  return (_req: any, res: any, next: any): any => {
    const now = Date.now();
    const entry = paidRouteWindows.get(routeKey);
    if (!entry || now >= entry.resetAt) {
      paidRouteWindows.set(routeKey, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    if (entry.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: `Rate limit exceeded for ${routeKey} (${limit}/min). Retry in ${retryAfter}s.`,
        retryAfter,
      });
    }
    entry.count += 1;
    return next();
  };
};

let _llmHealthCache: { result: Record<string, any>; expiresAt: number } | null =
  null;
const LLM_HEALTH_CACHE_MS = 60_000;


const isSafeSessionId = (value: string) => /^[A-Za-z0-9_-]{8,80}$/.test(value);
const isSafeLeadId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);

const isPersistableLead = (lead: unknown): lead is Record<string, any> => {
  if (!lead || typeof lead !== "object" || Array.isArray(lead)) return false;
  const value = lead as Record<string, any>;
  return Boolean(
    isSafeLeadId(String(value.id || "")) &&
    value.profile &&
    typeof value.profile === "object" &&
    !Array.isArray(value.profile) &&
    typeof value.profile.fullName === "string" &&
    leadStages.has(value.stage) &&
    (value.reviewStatus === undefined ||
      reviewStatuses.has(value.reviewStatus)) &&
    (value.nextAction === undefined || nextActions.has(value.nextAction)) &&
    (value.kind === undefined || leadKinds.has(value.kind)) &&
    (value.source === undefined || leadSources.has(value.source)) &&
    (value.business === undefined ||
      (Boolean(value.business) &&
        typeof value.business === "object" &&
        !Array.isArray(value.business) &&
        typeof value.business.name === "string" &&
        value.business.name.trim().length > 0)),
  );
};

export function parseOptionalPositiveInt(val: unknown): number | undefined {
  if (val === undefined || val === null || val === "") return undefined;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function parseBoundedLimit(val: unknown, defaultLimit: number, maxLimit: number): number {
  const parsed = parseOptionalPositiveInt(val);
  return parsed !== undefined ? Math.min(parsed, maxLimit) : defaultLimit;
}

router.get("/leads", (req, res): any => {
  try {
    const etag = getLeadsETag(req.query);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    const {
      stage,
      reviewStatus,
      nextAction,
      kind,
      source,
      search,
      limit,
      offset,
      summaryOnly,
    } = req.query as Record<string, string | undefined>;
    const parsedLimit =
      limit !== undefined
        ? parseBoundedLimit(limit, 50, 5000)
        : undefined;
    const parsedOffset = parseOptionalPositiveInt(offset);
    const isSummary = summaryOnly === "true";

    // Direct JSON assembly fast-path for the default unfiltered lead list
    if (
      !stage &&
      !reviewStatus &&
      !nextAction &&
      !kind &&
      !source &&
      !search &&
      !isSummary &&
      parsedLimit === undefined &&
      parsedOffset === undefined
    ) {
      const db = getLeadsDb();
      const rows = db
        .prepare(
          "SELECT payload FROM leads ORDER BY created_at DESC, updated_at DESC",
        )
        .all() as { payload: string }[];
      const total =
        (db.prepare("SELECT COUNT(*) as count FROM leads").get() as any)
          ?.count ?? rows.length;
      const stats = readLeadsStats();
      const initialized = hasLeadStoreBeenInitialized();
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.send(
        `{"apiVersion":1,"leads":[${rows.map((r) => r.payload).join(",")}],"total":${total},"stats":${JSON.stringify(stats)},"initialized":${initialized}}`,
      );
    }

    const result = readLeadsSummary({
      stage,
      reviewStatus,
      nextAction,
      kind,
      source,
      search,
      limit: parsedLimit,
      offset: parsedOffset,
      summaryOnly: isSummary,
    });

    const stats = readLeadsStats();
    res.json({
      apiVersion: 1,
      leads: result.leads,
      total: result.total,
      stats,
      initialized: hasLeadStoreBeenInitialized(),
    });
  } catch (error: any) {
    console.error("Failed to read leads from SQLite:", error);
    res.status(500).json({ error: error.message || "Failed to read leads" });
  }
});

router.get("/leads/stats", (req, res): any => {
  try {
    const etag = getLeadsETag({ route: "stats" });
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }
    const stats = readLeadsStats();
    res.json({
      apiVersion: 1,
      ...stats,
    });
  } catch (error: any) {
    console.error("Failed to read leads stats from SQLite:", error);
    res.status(500).json({ error: error.message || "Failed to read leads stats" });
  }
});

router.put("/leads", (req, res): any => {
  if (!process.env.APEX_ALLOW_LEGACY_REPLACE) {
    return res.status(405).json({
      error:
        "Bulk lead replacement is disabled. Set APEX_ALLOW_LEGACY_REPLACE=true in .env to enable it.",
      code: "LEGACY_REPLACE_DISABLED",
    });
  }
  try {
    const leads = normalizeIncomingLeads(req.body?.leads);
    if (!leads || leads.length > 1_000 || !leads.every(isPersistableLead)) {
      return res
        .status(400)
        .json({ error: "Expected up to 1,000 valid lead records." });
    }

    replaceStoredLeads(leads);
    res.json({ apiVersion: 1, success: true, count: leads.length });
  } catch (error: any) {
    console.error("Failed to persist leads to SQLite:", error);
    res.status(500).json({ error: error.message || "Failed to persist leads" });
  }
});

router.patch("/leads/:id", (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead id." });
    }
    const lead = { ...(req.body?.lead || {}), id: req.params.id };
    if (!lead.createdAt) {
      lead.createdAt = new Date().toISOString();
    }
    if (!isPersistableLead(lead)) {
      return res.status(400).json({ error: "Expected a valid lead object." });
    }
    const previousLead = readStoredLeadById(req.params.id);
    const previousStage = previousLead?.stage;

    const allowCreate = req.body?.allowCreate === true;
    if (previousLead && !allowCreate) {
      if (!Number.isInteger(lead.revision)) {
        return res.status(400).json({
          apiVersion: 1,
          error: "Integer revision is required when updating an existing lead.",
          code: "REVISION_REQUIRED",
        });
      }
    }

    const writeResult = upsertLeadWithIdentity(lead, {
      requireExisting: !allowCreate,
    });
    const storedLead = writeResult.lead;

    if (
      writeResult.disposition !== "duplicate" &&
      storedLead.stage &&
      previousStage &&
      previousStage !== storedLead.stage
    ) {
      insertLeadActivity({
        leadId: storedLead.id,
        type: "stage_change",
        fromValue: previousStage,
        toValue: storedLead.stage,
        actor: "user",
        createdAt: new Date().toISOString(),
      });
    }

    const previousReviewStatus = previousLead?.reviewStatus;
    // G17: REPLIED transitions now produce a positive outcome signal
    // (previously silent). Binary {positive, negative} + detail stage.
    const isNewReply =
      ((storedLead.stage === "REPLIED" || (storedLead as any)?.reviewStatus === "REPLIED") &&
        previousStage !== "REPLIED" && previousReviewStatus !== "REPLIED");
    const isNewRejection =
      ((storedLead.reviewStatus === "REJECT" || storedLead.reviewStatus === "REJECTED") &&
        previousReviewStatus !== "REJECT" && previousReviewStatus !== "REJECTED") ||
      ((storedLead.stage === "LOST" || storedLead.stage === "UNQUALIFIED") &&
        previousStage !== "LOST" && previousStage !== "UNQUALIFIED");
    const isNewDirectVerification =
      ((storedLead.reviewStatus === "KEEP" || storedLead.reviewStatus === "VERIFIED") &&
        previousReviewStatus !== "KEEP" && previousReviewStatus !== "VERIFIED") ||
      ((storedLead.stage === "CONVERTED" || storedLead.stage === "CLOSED_WON") &&
        previousStage !== "CONVERTED" && previousStage !== "CLOSED_WON") ||
      ((storedLead.stage === "MEETING BOOKED" || storedLead.stage === "MEETING_SCHEDULED") &&
        previousStage !== "MEETING BOOKED" && previousStage !== "MEETING_SCHEDULED");
    const isNewVerification = isNewDirectVerification || isNewReply;

    // G17: every stage/review transition writes a binary outcome row.
    if (previousStage !== storedLead.stage || previousReviewStatus !== storedLead.reviewStatus) {
      try {
        if (isNewReply) {
          recordLeadOutcome(storedLead.id, "positive", "REPLIED");
        } else if (isNewDirectVerification) {
          recordLeadOutcome(storedLead.id, "positive", String(storedLead.stage || storedLead.reviewStatus));
        } else if (isNewRejection) {
          recordLeadOutcome(storedLead.id, "negative", String(storedLead.stage || storedLead.reviewStatus));
        }
      } catch (err) {
        console.warn("[lead-outcomes] Failed to record lead outcome:", err);
      }
    }

    if (isNewRejection || isNewVerification) {
      // G5: read the producing arm from top-level fields (written by
      // leadMapping) with evidence/scout fallbacks, and pass domainCluster
      // so the feedback scope key matches the scheduler retrieval key.
      const family = storedLead.discoveryFamily || storedLead.evidence?.discoveryFamily || storedLead.scout?.family || "general";
      const lane = storedLead.discoveryLane || storedLead.evidence?.discoveryLane || storedLead.scout?.lane || "person";
      const provider = storedLead.evidence?.sourceProvider || storedLead.source || "tavily";
      try {
        const briefText = `${storedLead.profile?.currentTitle || storedLead.title || ""} ${storedLead.profile?.currentCompany || storedLead.company || ""} ${storedLead.profile?.industry || ""}`;
        recordQueryPerformance({
          domainCluster: deriveDomainCluster(briefText),
          family,
          lane,
          provider,
          runs: 0,
          outcomeRuns: 1,
          qualifiedCandidates: isNewVerification ? 1 : 0,
          hardFailedCandidates: isNewRejection ? 1 : 0,
          rescuedCandidates: 0,
        });
      } catch (err) {
        console.warn("[lead-review-feedback] Failed to record query performance feedback:", err);
      }
    }

    res.json({
      apiVersion: 1,
      success: true,
      disposition: writeResult.disposition,
      lead: storedLead,
    });
  } catch (error: any) {
    if (error instanceof LeadNotFoundError) {
      return res
        .status(409)
        .json({
          apiVersion: 1,
          error: error.message,
          code: "LEAD_NO_LONGER_EXISTS",
        });
    }
    if (error instanceof LeadRevisionConflictError) {
      return res
        .status(409)
        .json({
          apiVersion: 1,
          error: error.message,
          code: "LEAD_REVISION_CONFLICT",
          lead: error.currentLead,
        });
    }
    console.error(`Failed to upsert lead ${req.params.id} to SQLite:`, error);
    res.status(500).json({ error: error.message || "Failed to upsert lead" });
  }
});

router.delete("/leads/:id", (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead id." });
    }
    deleteLead(req.params.id);
    res.json({ apiVersion: 1, success: true });
  } catch (error: any) {
    console.error(`Failed to delete lead ${req.params.id} from SQLite:`, error);
    res.status(500).json({ error: error.message || "Failed to delete lead" });
  }
});

router.get("/leads/:id/activities", (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead id." });
    }
    const limit = parseBoundedLimit(req.query.limit, 50, 500);
    const activities = readLeadActivities(req.params.id, limit);
    res.json({ apiVersion: 1, activities });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: error.message || "Failed to read lead activities." });
  }
});

router.post("/leads/:id/merge", (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: "Invalid winner lead id." });
    }
    const duplicateId =
      typeof req.body?.duplicateId === "string"
        ? req.body.duplicateId.trim()
        : "";
    if (!duplicateId || !isSafeLeadId(duplicateId)) {
      return res
        .status(400)
        .json({ error: "duplicateId must be a valid lead id string." });
    }
    if (req.params.id === duplicateId) {
      return res
        .status(400)
        .json({ error: "A lead cannot be merged into itself." });
    }

    const db = getLeadsDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const winner = readStoredLeadById(req.params.id);
      const duplicate = readStoredLeadById(duplicateId);

      if (!winner) {
        db.exec("ROLLBACK");
        return res.status(404).json({ error: "Winner lead not found." });
      }
      if (!duplicate) {
        db.exec("ROLLBACK");
        return res.status(404).json({ error: "Duplicate lead not found." });
      }

      // Merge strategy: keep winner's fields; fill blanks from duplicate.
      const mergeField = <T>(winVal: T, dupVal: T): T =>
        winVal === null || winVal === undefined || winVal === ""
          ? dupVal
          : winVal;

      const mergedProfile = {
        ...duplicate.profile, // Start with duplicate as base
        ...winner.profile, // Winner fields overwrite
        // Specifically fill in any blank profile fields from duplicate:
        headline: mergeField(
          winner.profile.headline,
          duplicate.profile.headline,
        ),
        summary: mergeField(winner.profile.summary, duplicate.profile.summary),
        location: mergeField(
          winner.profile.location,
          duplicate.profile.location,
        ),
        industry: mergeField(
          winner.profile.industry,
          duplicate.profile.industry,
        ),
        seniorityLevel: mergeField(
          winner.profile.seniorityLevel,
          duplicate.profile.seniorityLevel,
        ),
        companySizeEst: mergeField(
          winner.profile.companySizeEst,
          duplicate.profile.companySizeEst,
        ),
        contactDetails: {
          ...(duplicate.profile.contactDetails || {}),
          ...(winner.profile.contactDetails || {}),
          // If winner has no email but duplicate does, use duplicate's.
          email: mergeField(
            winner.profile.contactDetails?.email,
            duplicate.profile.contactDetails?.email,
          ),
          phone: mergeField(
            winner.profile.contactDetails?.phone,
            duplicate.profile.contactDetails?.phone,
          ),
          linkedinUrl: mergeField(
            winner.profile.contactDetails?.linkedinUrl,
            duplicate.profile.contactDetails?.linkedinUrl,
          ),
        },
        skills: Array.from(
          new Set([
            ...(winner.profile.skills || []),
            ...(duplicate.profile.skills || []),
          ]),
        ),
        experiences: winner.profile.experiences?.length
          ? winner.profile.experiences
          : duplicate.profile.experiences || [],
        education: winner.profile.education?.length
          ? winner.profile.education
          : duplicate.profile.education || [],
      };

      // Union tags, deduplicated.
      const mergedTags = Array.from(
        new Set([...(winner.tags || []), ...(duplicate.tags || [])]),
      );

      const mergedLead = {
        ...winner,
        profile: mergedProfile,
        tags: mergedTags,
        notes: winner.notes || duplicate.notes || "",
        lastEnrichedAt: winner.lastEnrichedAt || duplicate.lastEnrichedAt,
        companyAccount: winner.companyAccount || duplicate.companyAccount,
        evidence: winner.evidence || duplicate.evidence,
        reviewStatus:
          mergeField(winner.reviewStatus, duplicate.reviewStatus) ||
          "UNREVIEWED",
        nextAction:
          mergeField(winner.nextAction, duplicate.nextAction) || "NONE",
      };

      const mergedWrite = upsertLeadInExistingTransaction(db, mergedLead, {
        requireExisting: true,
      });
      if (
        mergedWrite.disposition === "duplicate" &&
        mergedWrite.lead.id !== winner.id
      ) {
        throw new Error(
          "Cannot merge because the winner LinkedIn identity belongs to another prospect.",
        );
      }
      transferLeadIdentities(db, duplicateId, winner.id);
      db.prepare("UPDATE outreach_drafts SET lead_id = ? WHERE lead_id = ?").run(winner.id, duplicateId);
      db.prepare("UPDATE lead_activities SET lead_id = ? WHERE lead_id = ?").run(winner.id, duplicateId);
      db.prepare("DELETE FROM lead_identity_conflicts WHERE canonical_lead_id = ? OR duplicate_lead_id = ?").run(duplicateId, duplicateId);
      db.prepare("DELETE FROM leads WHERE id = ?").run(duplicateId);

      // Log the merge activity.
      insertLeadActivity({
        leadId: winner.id,
        type: "merge",
        fromValue: duplicateId,
        toValue: winner.id,
        actor: "user",
        createdAt: new Date().toISOString(),
      });

      db.exec("COMMIT");

      invalidateLeadsStatsCache();

      const savedMerged = readStoredLeadById(winner.id);
      res.json({ apiVersion: 1, lead: savedMerged, deleted: duplicateId });
    } catch (innerError) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw innerError;
    }
  } catch (error: any) {
    console.error("Failed to merge leads:", error);
    res.status(500).json({ error: error.message || "Lead merge failed." });
  }
});

router.delete("/leads", (req, res): any => {
  try {
    const ids = req.body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length > 1_000 ||
      !ids.every((id) => typeof id === "string" && isSafeLeadId(id))
    ) {
      return res
        .status(400)
        .json({
          error: "Expected up to 1,000 valid lead ids in request body.",
        });
    }
    const db = getLeadsDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        deleteLeadInExistingTransaction(db, id);
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    }
    res.json({ apiVersion: 1, success: true, count: ids.length });
  } catch (error: any) {
    console.error("Failed to bulk delete leads from SQLite:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to bulk delete leads" });
  }
});

router.post("/leads/bulk", (req, res): any => {
  try {
    const leads = normalizeIncomingLeads(req.body?.leads);
    if (!leads || leads.length > 1_000 || !leads.every(isPersistableLead)) {
      return res
        .status(400)
        .json({ error: "Expected up to 1,000 valid lead records." });
    }
    const perItemConflict = req.body?.perItemConflict !== false;
    const writeResults = upsertLeadsWithIdentity(leads, {
      requireExisting: req.body?.requireExisting === true,
      perItemConflict,
    });
    const conflicts = writeResults
      .filter((result) => result.disposition === "conflict")
      .map((result) => ({
        incomingId: result.incomingLeadId,
        lead: result.lead,
      }));
    const duplicates = writeResults
      .filter((result) => result.disposition === "duplicate")
      .map((result) => ({
        incomingId: result.incomingLeadId,
        existingLeadId: result.lead.id,
        identityKey: result.identityKey,
        lead: result.lead,
      }));
    const createdCount = writeResults.filter(
      (result) => result.disposition === "created",
    ).length;
    const updatedCount = writeResults.filter(
      (result) => result.disposition === "updated",
    ).length;
    const committedLeads = writeResults
      .filter((result) => result.disposition === "created" || result.disposition === "updated")
      .map((result) => result.lead);
    res.json({
      apiVersion: 1,
      success: true,
      count: writeResults.length,
      leads: committedLeads,
      createdCount,
      updatedCount,
      duplicateCount: duplicates.length,
      duplicates,
      conflictCount: conflicts.length,
      conflicts,
    });
  } catch (error: any) {
    if (error instanceof LeadNotFoundError) {
      return res
        .status(409)
        .json({
          apiVersion: 1,
          error: error.message,
          code: "LEAD_NO_LONGER_EXISTS",
        });
    }
    if (error instanceof LeadRevisionConflictError) {
      return res
        .status(409)
        .json({
          apiVersion: 1,
          error: error.message,
          code: "LEAD_REVISION_CONFLICT",
          lead: error.currentLead,
        });
    }
    console.error("Failed to bulk upsert leads in SQLite:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to bulk upsert leads" });
  }
});

// Active Health check
router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    hasKey: hasOpenAIKey(),
    hasTavilyKey: hasTavilyKey(),
    hasOAuth: false,
    hasGoogleClient: false,
    brightData: getBrightDataStatus(),
    providerCapabilities: {
      tavily: { ...tavilyFreeTierCapabilities(), configured: hasTavilyKey() },
      brightData: getBrightDataCapabilities(),
    },
  });
});

router.get("/key-rotation-status", (_req, res) => {
  res.json({
    tavily: getTavilyKeyStatus(),
    brightData: getBrightDataStatus().keyPool,
  });
});

router.get("/llm-health", async (req, res) => {
  const configuredProviders = getLLMProviderSummaries();
  const force = req.query.force === "true";

  if (!force && _llmHealthCache && Date.now() < _llmHealthCache.expiresAt) {
    return res.json({
      ..._llmHealthCache.result,
      cached: true,
      configuredProviders,
    });
  }

  try {
    const response = await openAIText("Reply with exactly ok");
    const isOk = response.text.trim().toLowerCase().includes("ok");
    const result: Record<string, any> = {
      mode: "direct-fallback",
      provider: response.provider,
      baseUrl: response.baseUrl,
      model: response.model,
      ok: isOk,
      cached: false,
      ...(isOk ? {} : { error: `Unexpected response: ${response.text}` }),
    };
    _llmHealthCache = { result, expiresAt: Date.now() + LLM_HEALTH_CACHE_MS };
    res.json({ ...result, configuredProviders });
  } catch (error: any) {
    _llmHealthCache = null; // Do not cache failures
    res.json({
      mode: "direct-fallback",
      configuredProviders,
      ok: false,
      cached: false,
      error: error.message || String(error),
    });
  }
});

// Google OAuth is deprecated in favor of standalone primary LLM

// 1. Scrape Public URL / Name lookup via Search Grounding
router.post("/scrape-url", paidRouteLimit("scrape-url"), async (req, res): Promise<any> => {
  try {
    const { urlOrName } = req.body;
    if (!urlOrName) {
      return res.status(400).json({ error: "urlOrName is required" });
    }

    if (!hasOpenAIKey()) {
      return res
        .status(503)
        .json({
          error:
            "OPENAI_API_KEY is not configured. Add it to your .env file to enable real scraping.",
        });
    }

    // Step 1: Tavily search for public LinkedIn-indexed evidence
    console.log(`[scrape-url] Searching Tavily for: ${urlOrName}`);

    const { text: rawText, sources } = await tavilySearch(
      `${urlOrName} LinkedIn`,
      { signal: (req as any).signal }
    );

    if (!rawText || rawText.length < 50) {
      throw new Error(
        "Could not find sufficient public information about this person.",
      );
    }

    // Step 2: Structure the raw search result into CRM schema
    const structurePrompt = `You are a CRM data extraction engine. Convert the following raw professional profile research into a structured JSON object.

If a field is not found in the research, use an empty string - do NOT invent data.
For the fitScore, intentScore, and timingScore: score 1-10 based on how much signal exists.

Raw research data:
${rawText}`;

    const profile = await openAIStructured<any>(
      structurePrompt,
      singleProfileSchema,
      APEX_SYSTEM_PROMPT,
    );

    if (!profile || !profile.fullName) {
      throw new Error(
        "Could not extract a valid profile from the search results.",
      );
    }

    res.json({
      profile,
      sourceLinks: sources.slice(0, 5),
      rawText,
      sandboxMode: false,
    });
  } catch (error: any) {
    console.error("Error in /api/scrape-url:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to scrape this profile." });
  }
});

// 2. Extractor: Parse copy-pasted raw text or HTML block
router.post("/scrape-pasted", paidRouteLimit("scrape-pasted"), async (req, res): Promise<any> => {
  try {
    const { pastedText } = req.body;
    if (!pastedText || pastedText.trim().length < 20) {
      return res
        .status(400)
        .json({
          error:
            "Please paste a larger LinkedIn profile text block (minimum 20 characters).",
        });
    }

    if (!hasOpenAIKey()) {
      return res
        .status(503)
        .json({
          error:
            "OPENAI_API_KEY is not configured. Add it to your .env file to enable AI extraction.",
        });
    }

    // Single structured call - no grounding needed, text is already provided
    console.log("[scrape-pasted] Extracting profile from pasted text...");
    const prompt = `You are a CRM data extraction engine. The user has copy-pasted raw text from a LinkedIn profile or professional bio.

Extract every piece of professional information you can find and map it to the JSON schema.
Do NOT invent any data - only use what is present in the text below.
For email: if not explicitly stated, infer the most likely format based on name + company (label as INFERRED).
For fitScore / intentScore / timingScore: score 1-10 based on signals in the text.

Pasted text:
${pastedText}`;

    const profile = await openAIStructured<any>(
      prompt,
      singleProfileSchema,
      APEX_SYSTEM_PROMPT,
    );

    if (!profile || !profile.fullName) {
      throw new Error(
        "Could not extract a valid profile. Make sure the pasted text includes at least a name and job title.",
      );
    }

    res.json({ profile, sandboxMode: false });
  } catch (error: any) {
    console.error("Error in /api/scrape-pasted:", error);
    res
      .status(500)
      .json({
        error: error.message || "Failed to extract pasted profile data.",
      });
  }
});

// -----------------------------------------------------------------------------
// Search Logging & Mining Session Utilities
// -----------------------------------------------------------------------------

router.get("/search-logs", (req, res): any => {
  try {
    const { limit } = req.query as Record<string, string | undefined>;
    const parsedLimit =
      limit !== undefined ? Math.min(Math.max(Number(limit) || 1, 1), 500) : 30;
    const sessionById = new Map(
      readMiningSessions(parsedLimit).map((session) => [session.id, session]),
    );
    const logs = readSearchLogs(parsedLimit).map((log: any) => {
      const session = sessionById.get(log.id) || readMiningSessionSummaryById(log.id);
      const sessionTrace = (session?.traceSummary as any) || {};
      const providerSummary =
        sessionTrace.providerSummary && Object.keys(sessionTrace.providerSummary).length > 0
          ? sessionTrace.providerSummary
          : log.providerSummary && Object.keys(log.providerSummary).length > 0
            ? log.providerSummary
            : {};
      const costSummary =
        sessionTrace.costSummary && Object.keys(sessionTrace.costSummary).length > 0
          ? sessionTrace.costSummary
          : log.costSummary && Object.keys(log.costSummary).length > 0
            ? log.costSummary
            : {};
      const phaseTimeline =
        Array.isArray(sessionTrace.phaseTimeline) && sessionTrace.phaseTimeline.length > 0
          ? sessionTrace.phaseTimeline
          : Array.isArray(log.phaseTimeline) && log.phaseTimeline.length > 0
            ? log.phaseTimeline
            : [];
      const eventCount =
        sessionTrace.eventCount !== undefined && sessionTrace.eventCount !== null
          ? Number(sessionTrace.eventCount)
          : Array.isArray(log.traceEvents) && log.traceEvents.length > 0
            ? log.traceEvents.length
            : Array.isArray(phaseTimeline) && phaseTimeline.length > 0
              ? phaseTimeline.reduce((acc: number, p: any) => acc + Number(p.events || 0), 0)
              : 0;

      const traceSummary = {
        sessionId: log.id,
        query: log.prompt,
        requested: session?.requestedLimit || 0,
        status: session?.status || log.status,
        startedAt: sessionTrace.startedAt || session?.startedAt || log.timestamp,
        endedAt: sessionTrace.endedAt || session?.completedAt,
        durationMs: sessionTrace.durationMs,
        stopReason: sessionTrace.stopReason,
        returned: log.leadsFound || 0,
        eventCount,
        providerSummary,
        costSummary,
        phaseTimeline,
        schemaVersion: sessionTrace.schemaVersion || log.schemaVersion || 1,
      };

      return {
        id: log.id,
        timestamp: log.timestamp,
        prompt: log.prompt,
        generatedQueries: log.generatedQueries,
        status: session?.status || log.status,
        errorMessage: session?.errorMessage || log.errorMessage,
        rawResultsCount: log.rawResultsCount,
        leadsFound: log.leadsFound,
        detailedLogs: undefined,
        debugLogs: undefined,
        traceEvents: [],
        traceSummary,
        providerSummary,
        costSummary,
        phaseTimeline,
      };
    });
    res.json({ apiVersion: 1, logs });
  } catch (error: any) {
    console.error("Failed to read search logs:", error);
    res.status(500).json({ error: "Failed to retrieve search logs." });
  }
});

router.get("/search-logs/:id", (req, res): any => {
  try {
    const log = readSearchLogById(req.params.id);
    if (!log) return res.status(404).json({ error: "Search log not found." });
    const session = readMiningSessionSummaryById(req.params.id) || readMiningSessionById(req.params.id);
    const sessionTrace = (session?.traceSummary as any) || {};
    const providerSummary =
      sessionTrace.providerSummary && Object.keys(sessionTrace.providerSummary).length > 0
        ? sessionTrace.providerSummary
        : log.providerSummary && Object.keys(log.providerSummary).length > 0
          ? log.providerSummary
          : {};
    const costSummary =
      sessionTrace.costSummary && Object.keys(sessionTrace.costSummary).length > 0
        ? sessionTrace.costSummary
        : log.costSummary && Object.keys(log.costSummary).length > 0
          ? log.costSummary
          : {};
    const phaseTimeline =
      Array.isArray(sessionTrace.phaseTimeline) && sessionTrace.phaseTimeline.length > 0
        ? sessionTrace.phaseTimeline
        : Array.isArray(log.phaseTimeline) && log.phaseTimeline.length > 0
          ? log.phaseTimeline
          : [];
    const eventCount =
      sessionTrace.eventCount !== undefined && sessionTrace.eventCount !== null
        ? Number(sessionTrace.eventCount)
        : Array.isArray(log.traceEvents) && log.traceEvents.length > 0
          ? log.traceEvents.length
          : Array.isArray(phaseTimeline) && phaseTimeline.length > 0
            ? phaseTimeline.reduce((acc: number, p: any) => acc + Number(p.events || 0), 0)
            : 0;

    const traceSummary = {
      sessionId: log.id,
      query: log.prompt,
      requested: session?.requestedLimit || 0,
      status: session?.status || log.status,
      startedAt: sessionTrace.startedAt || session?.startedAt || log.timestamp,
      endedAt: sessionTrace.endedAt || session?.completedAt,
      durationMs: sessionTrace.durationMs,
      stopReason: sessionTrace.stopReason,
      returned: log.leadsFound || 0,
      eventCount,
      providerSummary,
      costSummary,
      phaseTimeline,
      schemaVersion: sessionTrace.schemaVersion || log.schemaVersion || 1,
    };

    res.json({
      apiVersion: 1,
      log: {
        ...log,
        status: session?.status || log.status,
        errorMessage: session?.errorMessage || log.errorMessage,
        traceSummary,
        providerSummary,
        costSummary,
        phaseTimeline,
      },
    });
  } catch (error: any) {
    console.error("Failed to read search log:", error);
    res.status(500).json({ error: "Failed to retrieve search log." });
  }
});

router.get("/search-logs/:id/live", (req, res): any => {
  if (!isSafeSessionId(req.params.id)) {
    return res.status(400).json({ error: "Invalid sessionId." });
  }
  const logs = discoveryEngine.getLiveLogs(req.params.id) || [];
  const traceEvents = discoveryEngine.getLiveTrace(req.params.id) || [];
  res.json({
    apiVersion: 1,
    logs,
    traceEvents,
    session: readMiningSessionById(req.params.id),
  });
});

router.get("/mining-sessions/:sessionId/stream", (req, res): any => {
  const { sessionId } = req.params;
  if (!isSafeSessionId(sessionId)) {
    return res.status(400).json({ error: "Invalid sessionId." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Guard against unhandled socket/stream errors (e.g. EPIPE, ECONNRESET)
  const suppressDisconnectError = () => {
    // Ignore expected client disconnect errors
  };
  res.on("error", suppressDisconnectError);
  req.on("error", suppressDisconnectError);
  req.socket?.on("error", suppressDisconnectError);

  const writeBuffer: string[] = [];
  let isDraining = false;

  const flushBuffer = () => {
    while (writeBuffer.length > 0) {
      if (res.writableEnded || res.closed || res.destroyed || !res.socket?.writable) {
        writeBuffer.length = 0;
        return;
      }
      const nextChunk = writeBuffer.shift()!;
      try {
        const ok = res.write(nextChunk);
        if (!ok) {
          res.once("drain", flushBuffer);
          return;
        }
      } catch {
        writeBuffer.length = 0;
        return;
      }
    }
    isDraining = false;
  };

  const safeWrite = (chunk: string): boolean => {
    if (res.writableEnded || res.closed || res.destroyed || !res.socket?.writable) return false;
    try {
      if (isDraining) {
        if (writeBuffer.length < 200) {
          writeBuffer.push(chunk);
        }
        return false;
      }
      const ok = res.write(chunk);
      if (!ok) {
        isDraining = true;
        res.once("drain", flushBuffer);
      }
      return ok;
    } catch {
      return false;
    }
  };

  // Initial snapshot frame so late joiners catch up without polling.
  const logs = discoveryEngine.getLiveLogs(sessionId) || [];
  const traceEvents = discoveryEngine.getLiveTrace(sessionId) || [];
  safeWrite(
    `data: ${JSON.stringify({ logs, traceEvents, session: readMiningSessionSummaryById(sessionId) })}\n\n`,
  );

  let unsubscribed = false;
  let unsubscribe: (() => void) | null = null;
  const doUnsubscribe = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    writeBuffer.length = 0;
    if (unsubscribe) unsubscribe();
  };

  // Hub fans out one poll interval + one DB read per session to all
  // subscribers, instead of each connection polling independently.
  unsubscribe = sessionStreamHub.subscribe(sessionId, (frame) => {
    if (res.writableEnded || res.closed) {
      doUnsubscribe();
      return;
    }
    if (
      frame.logs.length > 0 ||
      frame.traceEvents.length > 0 ||
      frame.session
    ) {
      safeWrite(`data: ${JSON.stringify(frame)}\n\n`);
    }
    const status = frame.session?.status;
    const isTerminated =
      (status && status !== "running" && status !== "cancellation_requested") ||
      (frame.session === null && frame.logs.some((log) => log.includes("Session not found")));
    if (isTerminated) {
      doUnsubscribe();
      safeWrite("event: end\ndata: {}\n\n");
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  req.on("close", doUnsubscribe);
  res.on("close", doUnsubscribe);
});

router.get("/mining-sessions", (req, res): any => {
  try {
    res.json({
      apiVersion: 1,
      sessions: readMiningSessions(Number(req.query.limit || 25)),
    });
  } catch (error: any) {
    console.error("Failed to read mining sessions:", error);
    res.status(500).json({ error: "Failed to retrieve mining sessions." });
  }
});

router.get("/mining-sessions/resumable", (_req, res): any => {
  try {
    res.json({ apiVersion: 1, sessions: readResumableMiningSessions() });
  } catch (error: any) {
    console.error("Failed to read resumable mining sessions:", error);
    res
      .status(500)
      .json({ error: "Failed to retrieve resumable mining sessions." });
  }
});

router.delete("/mining-sessions/resumable", (req, res): any => {
  try {
    const sessionIds = Array.isArray(req.body?.sessionIds)
      ? req.body.sessionIds.filter(
          (id: any) => typeof id === "string" && isSafeSessionId(id),
        )
      : [];
    if (sessionIds.length > 0) {
      const activeIds = sessionIds.filter((id: string) =>
        discoveryEngine.isActive(id),
      );
      if (activeIds.length > 0) {
        return res.status(409).json({
          error: `Cannot delete active mining sessions: ${activeIds.join(", ")}. Cancel them first.`,
          activeIds,
        });
      }
      const deletedCount = deleteMiningSessions(sessionIds);
      return res.json({ apiVersion: 1, success: true, deletedCount });
    }

    const isConfirmedSweep =
      req.body?.all === true || req.query.confirm === "all";
    if (!isConfirmedSweep) {
      return res.status(400).json({
        error:
          "Explicit confirmation ({ all: true } or ?confirm=all) or a non-empty sessionIds array is required to delete sessions.",
      });
    }

    const deletedCount = clearResumableMiningSessions();
    return res.json({ apiVersion: 1, success: true, deletedCount });
  } catch (error: any) {
    console.error("Failed to delete resumable mining sessions:", error);
    return res
      .status(500)
      .json({ error: "Failed to delete resumable mining sessions." });
  }
});

router.get("/mining-sessions/active", (_req, res): any => {
  try {
    const sessionId = discoveryEngine.getActiveSessionId();
    if (sessionId) {
      return res.json({
        apiVersion: 1,
        active: true,
        sessionId,
        session: readMiningSessionById(sessionId),
      });
    }
    return res.json({ apiVersion: 1, active: false });
  } catch (error: any) {
    console.error("Failed to check active mining session:", error);
    return res
      .status(500)
      .json({ error: "Failed to check active mining session." });
  }
});

router.get("/mining-sessions/:sessionId", (req, res): any => {
  if (!isSafeSessionId(req.params.sessionId))
    return res.status(400).json({ error: "Invalid sessionId." });
  const session = readMiningSessionById(req.params.sessionId);
  if (!session)
    return res.status(404).json({ error: "Mining session not found." });
  res.json({ apiVersion: 1, session });
});

router.delete("/mining-sessions/:sessionId", (req, res): any => {
  const { sessionId } = req.params;
  if (!isSafeSessionId(sessionId))
    return res.status(400).json({ error: "Invalid sessionId." });

  if (discoveryEngine.isActive(sessionId)) {
    return res.status(409).json({
      error: `Cannot delete active mining session: ${sessionId}. Cancel it first before deleting.`,
      sessionId,
      active: true,
    });
  }

  try {
    const deleted = deleteMiningSession(sessionId);
    if (!deleted)
      return res.status(404).json({ error: "Mining session not found." });
    return res.json({ apiVersion: 1, success: true, sessionId });
  } catch (error: any) {
    console.error("Failed to delete mining session:", error);
    return res.status(500).json({ error: "Failed to delete mining session." });
  }
});

router.post("/mining-sessions/:sessionId/cancel", (req, res): any => {
  const { sessionId } = req.params;
  if (!isSafeSessionId(sessionId))
    return res.status(400).json({ error: "Invalid sessionId." });
  if (!discoveryEngine.isActive(sessionId))
    return res
      .status(404)
      .json({ error: "Mining session is not active.", sessionId });

  discoveryEngine.cancel(sessionId);
  const cancellationRequestedAt = new Date().toISOString();
  discoveryEngine.addLog(
    sessionId,
    `[${cancellationRequestedAt}] Cancellation requested by local user.`,
  );
  const session = upsertMiningSession({
    id: sessionId,
    status: "cancellation_requested",
    cancellationRequestedAt,
  });
  res
    .status(202)
    .json({
      apiVersion: 1,
      success: true,
      sessionId,
      status: "cancellation_requested",
      session,
    });
});

router.post(
  "/mining-sessions/:sessionId/resume",
  async (req, res): Promise<any> => {
    const { sessionId } = req.params;
    if (!isSafeSessionId(sessionId))
      return res.status(400).json({ error: "Invalid sessionId." });

    if (discoveryEngine.isActive(sessionId)) {
      return res
        .status(409)
        .json({ error: `Session is already active: ${sessionId}`, sessionId });
    }

    const checkpoint = readMiningSessionCheckpoint(sessionId);
    if (!checkpoint) {
      return res
        .status(404)
        .json({
          error: `No resumable checkpoint found for session: ${sessionId}`,
        });
    }

    const isAsyncMode =
      req.query.mode === "job" || req.headers["prefer"] === "respond-async";

    if (isAsyncMode) {
      discoveryEngine.resume(sessionId).catch((err) => {
        if (err instanceof SessionAlreadyActiveError) return;
        console.error(
          `[mining-session resume background error] ${sessionId}:`,
          err,
        );
      });

      // The engine's atomic claim decides; a lost race returns 409
      if (discoveryEngine.isActive(sessionId)) {
        return res.status(202).json({
          apiVersion: 1,
          status: "running",
          sessionId,
          streamUrl: `/api/mining-sessions/${sessionId}/stream`,
          resumedFromRound: checkpoint.round,
          message: `Resuming mining session from round ${checkpoint.round}.`,
        });
      }

      return res
        .status(409)
        .json({
          error: `A lead mining session with this sessionId is already active: ${sessionId}`,
          sessionId,
        });
    }

    try {
      const result = await discoveryEngine.resume(sessionId);
      return res.status(200).json(result);
    } catch (error: any) {
      // The engine's atomic claim is authoritative; the pre-check above is only
      // a fast path. A lost race here still maps to the same 409 contract.
      if (error instanceof SessionAlreadyActiveError) {
        return res
          .status(409)
          .json({
            error: `Session is already active: ${sessionId}`,
            sessionId,
          });
      }
      const cancelled =
        error.name === "AbortError" ||
        String(error.message || "").includes("cancelled");
      return res
        .status(cancelled ? 499 : 500)
        .json({
          error: error.message || "Failed to resume lead mining session.",
          cancelled,
        });
    }
  },
);

router.get("/engine-metrics", (req, res): any => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    res.json({ apiVersion: 1, metrics: readEngineMetrics(limit) });
  } catch (error: any) {
    console.error("Failed to read engine metrics:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to compute engine metrics." });
  }
});

router.get("/provider-capabilities", (_req, res): any => {
  try {
    const discoveryProviderMode = resolveDiscoveryProviderMode({
      brightDataConfigured: isBrightDataConfigured(),
      tavilyConfigured: hasTavilyKey(),
    });
    const brightDataSearchMode = resolveBrightDataSearchMode({
      discoveryMode: discoveryProviderMode,
    });
    res.json({
      apiVersion: 1,
      discoveryProviderMode,
      brightDataSearchMode,
      creditReservation: isProviderCreditReservationEnabled()
        ? "enabled"
        : "disabled",
      keyRotation: "preferred",
      tavily: {
        ...tavilyFreeTierCapabilities(),
        configured: hasTavilyKey(),
        usage: readProviderUsage("tavily"),
        keyPool: getTavilyKeyStatus(),
      },
      brightData: {
        ...getBrightDataCapabilities(),
        usage: readProviderUsage("brightdata"),
        status: getBrightDataStatus(),
        batchTool: getBrightDataStatus().batchTool,
      },
    });
  } catch (error: any) {
    res
      .status(500)
      .json({
        error: error.message || "Could not read provider capabilities.",
      });
  }
});

router.get("/saved-searches", (req, res): any => {
  try {
    res.json({
      apiVersion: 1,
      searches: readSavedSearches(Number(req.query.limit || 50)),
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: error.message || "Could not read saved searches." });
  }
});

router.post("/saved-searches", (req, res): any => {
  try {
    const query = String(req.body?.query || "").trim();
    const spec = normalizeSearchSpec(req.body?.spec, query);
    const record = upsertSavedSearch({
      id: typeof req.body?.id === "string" ? req.body.id : undefined,
      name: String(req.body?.name || "").trim(),
      query,
      spec,
      mode: spec.mode,
      maxPerCompany: spec.maxPerCompany,
    });
    res.status(201).json({ apiVersion: 1, search: record });
  } catch (error: any) {
    res.status(400).json({ error: error.message || "Could not save search." });
  }
});

router.delete("/saved-searches/:id", (req, res): any => {
  try {
    res.json({ apiVersion: 1, deleted: deleteSavedSearch(req.params.id) > 0 });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: error.message || "Could not delete saved search." });
  }
});

router.post("/lead-search/preview", async (req, res): Promise<any> => {
  const query = String(req.body?.query || "").trim();
  if (!query)
    return res
      .status(400)
      .json({ error: "Search criteria/query is required." });
  const requestedMode = req.body?.discoveryMode as DiscoveryMode | undefined;
  let spec = normalizeSearchSpec(req.body?.searchSpec, query);
  if (!req.body?.searchSpec) {
    spec = buildFallbackSearchSpec(query, requestedMode);
    if (hasOpenAIKey()) {
      try {
        spec = normalizeSearchSpec(
          await openAIStructured(
            buildSearchSpecPrompt(query),
            searchSpecSchema,
            STRATEGIST_SYSTEM_PROMPT,
            { maxTokens: 700, temperature: 0 },
          ),
          query,
        );
      } catch {
        // A deterministic preview still lets the user edit and run a search when LLM planning is unavailable.
      }
    }
  }
  const tasks = buildRetrievalTasks(
    buildScoutFallbackQueryPlan(query, spec),
    spec,
  );
  res.json({
    apiVersion: 1,
    spec,
    tasks,
    capabilities: {
      tavily: { ...tavilyFreeTierCapabilities(), configured: hasTavilyKey() },
      brightData: getBrightDataCapabilities(),
    },
  });
});

router.get("/mining-sessions/:sessionId/trace", (req, res): any => {
  try {
    const log = readSearchLogById(req.params.sessionId);
    const session = readMiningSessionById(req.params.sessionId);
    if (!log && !session)
      return res.status(404).json({ error: "Mining session trace not found." });
    res.json({
      apiVersion: 1,
      session,
      sessionId: log?.id || session?.id,
      timestamp: log?.timestamp || session?.startedAt,
      prompt: log?.prompt || session?.prompt,
      status: session?.status || log?.status,
      errorMessage: session?.errorMessage || log?.errorMessage,
      rawResultsCount: log?.rawResultsCount || 0,
      leadsFound: log?.leadsFound || 0,
      detailedLogs: log?.detailedLogs || "",
      debugLogs: log?.debugLogs || "",
      traceEvents: log?.traceEvents || [],
      providerSummary: log?.providerSummary || {},
      costSummary: log?.costSummary || {},
      phaseTimeline: log?.phaseTimeline || [],
      schemaVersion: log?.schemaVersion || 1,
    });
  } catch (error: any) {
    console.error("Failed to read mining session trace:", error);
    res.status(500).json({ error: "Failed to retrieve mining session trace." });
  }
});

router.get("/mining-sessions/:sessionId/token-stats", (req, res): any => {
  try {
    const sessionId = req.params.sessionId;
    if (!sessionId || !isSafeSessionId(sessionId)) {
      return res.status(400).json({ error: "Invalid sessionId." });
    }
    const tokenStats = readMiningSessionTokenStats(sessionId);
    const langfuseHost =
      process.env.LANGFUSE_HOST ||
      process.env.LANGFUSE_BASE_URL ||
      process.env.LANGFUSE_BASEURL ||
      (process.env.LANGFUSE_PUBLIC_KEY ? "https://cloud.langfuse.com" : null);

    const projectId = process.env.LANGFUSE_PROJECT_ID || "cmtyxoeu400amad0itl1axqqm";
    const langfuseDeepLink = langfuseHost
      ? `${langfuseHost.replace(/\/$/, "")}/project/${projectId}/traces?search=${encodeURIComponent(sessionId)}`
      : null;

    res.json({
      ...tokenStats,
      langfuseHost,
      langfuseDeepLink,
      langfuseConfigured: Boolean(
        process.env.LANGFUSE_PUBLIC_KEY ||
        process.env.LANGFUSE_HOST ||
        process.env.LANGFUSE_BASE_URL,
      ),
    });
  } catch (error: any) {
    console.error("Failed to read token stats:", error);
    res.status(500).json({ error: "Failed to retrieve token statistics." });
  }
});
// 3. Multi-Purpose: Discover qualified lists of LinkedIn-indexed leads
router.post("/find-leads", async (req, res): Promise<any> => {
  const suppliedSessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  if (suppliedSessionId && !isSafeSessionId(suppliedSessionId)) {
    return res.status(400).json({ error: "Invalid sessionId." });
  }

  const suppliedParentSessionId =
    typeof req.body?.parentSessionId === "string" ? req.body.parentSessionId.trim() : "";
  if (suppliedParentSessionId && !isSafeSessionId(suppliedParentSessionId)) {
    return res.status(400).json({ error: "Invalid parentSessionId." });
  }

  const promptQuery = String(req.body?.query || req.body?.deltaBrief || "").trim();
  if (!promptQuery || promptQuery.length > 2000) {
    return res.status(400).json({
      error: "query must be a non-empty string of 2,000 characters or fewer.",
    });
  }

  const savedSearchId =
    typeof req.body?.savedSearchId === "string" && req.body.savedSearchId.trim()
      ? req.body.savedSearchId.trim()
      : undefined;

  let mergedExcludeList: string[] | undefined = Array.isArray(
    req.body?.excludeList,
  )
    ? [...req.body.excludeList]
    : undefined;

  if (savedSearchId) {
    const savedExclusions = getSavedSearchExcludeList(savedSearchId);
    if (savedExclusions.length > 0) {
      mergedExcludeList = Array.from(
        new Set([...(mergedExcludeList || []), ...savedExclusions]),
      );
    }
  }

  const isAsyncMode =
    req.query.mode === "job" || req.headers["prefer"] === "respond-async";
  const targetSessionId = suppliedSessionId || `session-${crypto.randomUUID()}`;

  // Bound concurrent discovery runs. Every session drives paid Tavily / Bright Data / LLM
  // work, and distinct sessionIds previously allowed an unbounded number of parallel
  // pipelines. Reject with 503 (retryable) rather than queueing, so callers fail fast.
  const maxConcurrentSessions = Math.min(
    Math.max(
      Number(process.env.APEX_MAX_CONCURRENT_SESSIONS || 2) || 2,
      1,
    ),
    8,
  );
  if (
    !discoveryEngine.isActive(targetSessionId) &&
    discoveryEngine.getActiveCount() >= maxConcurrentSessions
  ) {
    return res.status(503).json({
      error: `Already running ${discoveryEngine.getActiveCount()} discovery session(s) (limit ${maxConcurrentSessions}). Wait for one to finish, or raise APEX_MAX_CONCURRENT_SESSIONS.`,
      activeSessions: discoveryEngine.getActiveCount(),
      limit: maxConcurrentSessions,
      retryAfter: 30,
    });
  }

  if (isAsyncMode) {
    if (discoveryEngine.isActive(targetSessionId)) {
      return res.status(409).json({
        error: `A lead mining session with this sessionId is already active: ${targetSessionId}`,
        sessionId: targetSessionId,
      });
    }

    discoveryEngine
      .execute({
        sessionId: targetSessionId,
        promptQuery,
        requestedLimit: req.body?.limit,
        discoveryProviderMode:
          req.body?.discoveryMode || req.body?.discoveryProviderMode,
        searchSpec: req.body?.searchSpec,
        excludeList: mergedExcludeList,
        savedSearchId,
        parentSessionId:
          typeof req.body?.parentSessionId === "string"
            ? req.body.parentSessionId.trim() || undefined
            : undefined,
        deltaBrief:
          typeof req.body?.deltaBrief === "string"
            ? req.body.deltaBrief.trim() || undefined
            : undefined,
        interactive:
          typeof req.body?.interactive === "boolean"
            ? req.body.interactive
            : undefined,
      })
      .catch((err) => {
        if (err instanceof SessionAlreadyActiveError) return;
        console.error(`[find-leads background error] ${targetSessionId}:`, err);
      });

    // The engine's atomic claim decides; a lost race surfaces as an SSE
    // stream that ends immediately with the session's 409 state.
    if (discoveryEngine.isActive(targetSessionId)) {
      return res.status(202).json({
        apiVersion: 1,
        status: "running",
        sessionId: targetSessionId,
        streamUrl: `/api/mining-sessions/${targetSessionId}/stream`,
        message: "Discovery session accepted and executing in background.",
      });
    }
    return res
      .status(409)
      .json({
        error: `A lead mining session with this sessionId is already active: ${targetSessionId}`,
        sessionId: targetSessionId,
      });
  }

  try {
    const result = await discoveryEngine.execute({
      sessionId: targetSessionId,
      promptQuery,
      requestedLimit: req.body?.limit,
      discoveryProviderMode:
        req.body?.discoveryMode || req.body?.discoveryProviderMode,
      searchSpec: req.body?.searchSpec,
      excludeList: mergedExcludeList,
      savedSearchId,
      parentSessionId:
        typeof req.body?.parentSessionId === "string"
          ? req.body.parentSessionId.trim() || undefined
          : undefined,
      deltaBrief:
        typeof req.body?.deltaBrief === "string"
          ? req.body.deltaBrief.trim() || undefined
          : undefined,
      interactive:
        typeof req.body?.interactive === "boolean"
          ? req.body.interactive
          : undefined,
    });
    return res.status(200).json(result);
  } catch (error: any) {
    const cancelled =
      error.name === "AbortError" ||
      String(error.message || "").includes("cancelled");
    if (
      error instanceof SessionAlreadyActiveError ||
      error.message?.includes("already active")
    ) {
      return res
        .status(409)
        .json({ error: error.message, sessionId: suppliedSessionId });
    }
    if (error.message?.includes("must be a non-empty string")) {
      return res.status(400).json({ error: error.message });
    }
    return res
      .status(cancelled ? 499 : 500)
      .json({ error: error.message || "Failed to locate leads.", cancelled });
  } finally {
    await closeBrightDataClient({
      onlyIfIdle: true,
      onlyIfUnhealthy: true,
      reason: "find-leads-complete",
    });
  }
});

router.post("/leads/:id/enrich-profile", paidRouteLimit("enrich-profile"), async (req, res): Promise<any> => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: "Invalid lead id." });
    }
    const lead = readStoredLeadById(req.params.id);
    if (!lead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    const enrichRes = await enrichLeadProfile(lead, {
      force: req.body?.forceRefresh === true,
    });
    const currentLead = enrichRes.lead;
    const profileEnrichment = enrichRes.result;

    const latestLead = readStoredLeadById(req.params.id);
    if (!latestLead) throw new LeadNotFoundError(req.params.id);
    let storedLead = latestLead;
    if (
      profileEnrichment.status !== "error" &&
      profileEnrichment.updatedFields.length > 0
    ) {
      const latestProfile = latestLead.profile || {};
      const enrichedProfile = currentLead.profile || {};
      const mergedLead = {
        ...latestLead,
        profile: {
          ...latestProfile,
          fullName:
            !latestProfile.fullName || latestProfile.fullName === "Unknown"
              ? enrichedProfile.fullName || latestProfile.fullName
              : latestProfile.fullName,
          currentCompany:
            !latestProfile.currentCompany ||
            latestProfile.currentCompany === "Unknown"
              ? enrichedProfile.currentCompany || latestProfile.currentCompany
              : latestProfile.currentCompany,
          headline: latestProfile.headline || enrichedProfile.headline,
          location: latestProfile.location || enrichedProfile.location,
          industry: latestProfile.industry || enrichedProfile.industry,
          contactDetails: {
            ...(enrichedProfile.contactDetails || {}),
            ...(latestProfile.contactDetails || {}),
            email:
              latestProfile.contactDetails?.email ||
              enrichedProfile.contactDetails?.email,
          },
        },
        decisionMakerVerification: currentLead.decisionMakerVerification,
        evidence: currentLead.evidence,
        scoreBreakdown: currentLead.scoreBreakdown,
        scoreOverride: currentLead.scoreOverride,
        lastEnrichedAt: currentLead.lastEnrichedAt,
      };
      storedLead = upsertLeadWithIdentity(mergedLead, {
        requireExisting: true,
      }).lead;
    }

    if (profileEnrichment.status === "error") {
      return res.status(502).json({
        error: profileEnrichment.error || "Profile enrichment provider failed.",
        lead: latestLead,
        profileEnrichment,
        sandboxMode: false,
      });
    }

    res.json({
      lead: storedLead,
      profileEnrichment,
      sandboxMode: false,
    });
  } catch (error: any) {
    if (error instanceof LeadNotFoundError) {
      return res
        .status(409)
        .json({ error: error.message, code: "LEAD_NO_LONGER_EXISTS" });
    }
    if (error instanceof LeadRevisionConflictError) {
      return res
        .status(409)
        .json({
          error: error.message,
          code: "LEAD_REVISION_CONFLICT",
          lead: error.currentLead,
        });
    }
    console.error("Error in /api/leads/:id/enrich-profile:", error);
    res
      .status(500)
      .json({ error: error.message || "Profile enrichment failed." });
  }
});
// -- Outreach Draft Endpoints -------------------------------------------------

router.get("/outreach-drafts", (req, res): any => {
  try {
    const limit = parseBoundedLimit(req.query.limit, 50, 200);
    res.json({ apiVersion: 1, drafts: readOutreachDrafts(limit) });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: error.message || "Failed to read outreach drafts." });
  }
});

router.post("/outreach-drafts", (req, res): any => {
  try {
    const {
      id,
      leadId,
      leadName,
      companyName,
      tone,
      medium,
      sequenceStep,
      wordCount,
      body,
    } = req.body || {};
    if (
      typeof id !== "string" ||
      !id.trim() ||
      typeof leadId !== "string" ||
      !leadId.trim() ||
      typeof leadName !== "string" ||
      !leadName.trim() ||
      typeof body !== "string" ||
      !body.trim()
    ) {
      return res
        .status(400)
        .json({
          error: "id, leadId, leadName, and body are required strings.",
        });
    }
    if (!isSafeLeadId(id) || !isSafeLeadId(leadId)) {
      return res.status(400).json({ error: "Invalid id or leadId format." });
    }
    const draft = upsertOutreachDraft({
      id: id.trim(),
      leadId: leadId.trim(),
      leadName: String(leadName).trim(),
      companyName:
        typeof companyName === "string" ? companyName.trim() : undefined,
      tone: String(tone || "neutral").trim(),
      medium: String(medium || "email").trim(),
      sequenceStep: String(sequenceStep || "Step 1").trim(),
      wordCount: Number(wordCount || 0),
      body: String(body).trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    res.json({ apiVersion: 1, draft });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: error.message || "Failed to save outreach draft." });
  }
});

router.delete("/outreach-drafts/:id", (req, res): any => {
  try {
    if (!isSafeLeadId(req.params.id)) {
      return res.status(400).json({ error: "Invalid draft id." });
    }
    deleteOutreachDraft(req.params.id);
    res.json({ apiVersion: 1, success: true });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: error.message || "Failed to delete outreach draft." });
  }
});

router.post("/generate-outbound", paidRouteLimit("generate-outbound"), async (req, res): Promise<any> => {
  try {
    const {
      leadId,
      profile,
      tone,
      pitchType,
      valueProposition,
      senderName,
      senderCompany,
      sequenceStep,
      customInstruction,
      companyAccount,
      buyingSignals,
      buyingSignalsDetected,
      evidence,
      qualification,
      postIntentEvidence,
      companyIntentEvidence,
      notes,
    } = req.body;

    if (!profile || !profile.fullName) {
      return res
        .status(400)
        .json({ error: "Profile data is required for personalization." });
    }

    if (!hasOpenAIKey()) {
      return res
        .status(503)
        .json({
          error:
            "No LLM API key configured. Add BYESU_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY to your .env file to enable AI outreach generation.",
        });
    }

    console.log(
      `[generate-outbound] Generating outreach for: ${profile.fullName} (step: ${sequenceStep || "Step 1"})`,
    );
    // Load multi-touch thread context if leadId is available
    const priorDrafts =
      leadId && typeof leadId === "string"
        ? readOutreachDraftsByLeadId(leadId)
        : [];
    const priorDraftSummary =
      priorDrafts.length > 0
        ? priorDrafts
            .map(
              (d: any) =>
                `[${d.sequenceStep || "Earlier Touch"} (${d.medium || "Outreach"})]:\n"${d.body.slice(0, 300)}"`,
            )
            .join("\n\n")
        : "No prior sequence touchpoints recorded.";

    // Load few-shot style exemplars from recent approved drafts
    const recentDrafts = readOutreachDrafts(3);
    const styleExemplars =
      recentDrafts.length > 0
        ? recentDrafts
            .map(
              (d: any) =>
                `[Example Style - ${d.medium} - ${d.tone}]:\n"${d.body.slice(0, 250)}..."`,
            )
            .join("\n\n")
        : "";

    const prompt = buildOutboundPrompt({
      leadId,
      profile,
      tone,
      pitchType,
      valueProposition,
      senderName,
      senderCompany,
      sequenceStep,
      customInstruction,
      companyAccount,
      buyingSignals,
      buyingSignalsDetected,
      evidence,
      qualification,
      postIntentEvidence,
      companyIntentEvidence,
      notes,
      priorDraftSummary,
      styleExemplars,
    });

    const { text: rawText } = await openAIText(prompt, APEX_SYSTEM_PROMPT);

    if (!rawText) {
      throw new Error("Failed to generate outreach copy.");
    }

    const text = rawText
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .trim();

    res.json({ text, sandboxMode: false });
  } catch (error: any) {
    console.error("Error generating outbound copy:", error);
    res
      .status(500)
      .json({
        error: error.message || "Outreach template calculation failed.",
      });
  }
});

export const COPILOT_STOP_WORDS = new Set([
  "a", "about", "all", "an", "and", "any", "anybody", "anyone", "are", "as", "at", "be", "been",
  "best", "by", "can", "contact", "contacts", "could", "did", "do", "does", "find", "for",
  "from", "get", "give", "good", "had", "has", "have", "help", "how", "i", "in", "is", "it",
  "lead", "leads", "list", "look", "looking", "me", "my", "need", "of", "on", "or", "our",
  "out", "pipeline", "prospect", "prospects", "reach", "recommend", "search", "show",
  "somebody", "someone", "status", "suggest", "suggests", "tell", "that", "the", "these", "this", "those", "to", "today", "top", "up",
  "us", "want", "was", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would",
]);

// -----------------------------------------------------------------------------
// Conversational CRM Copilot
// -----------------------------------------------------------------------------
router.post("/chat", paidRouteLimit("chat"), async (req, res): Promise<any> => {
  try {
    const query =
      typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) return res.status(400).json({ error: "Query is required" });
    if (query.length > 2_000)
      return res
        .status(400)
        .json({ error: "Query must be 2,000 characters or fewer." });

    if (!hasOpenAIKey()) {
      return res
        .status(503)
        .json({
          error:
            "No LLM API key configured. Add BYESU_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY to your .env file to enable the AI Copilot.",
        });
    }

    // The database is canonical. Do not accept a browser-provided lead dump,
    // and omit contact details/notes from the model context by default.
    const { count: totalLeads, stageCounts } = readLeadsStageSummary();
    const stageSummary = Object.entries(stageCounts)
      .map(([stage, count]) => `- ${stage}: ${count}`)
      .join("\n");

    const topLeads = readLeadsSummary({ limit: 50, orderBy: "score" }).leads;
    const leadsContext =
      topLeads.length === 0
        ? "The CRM pipeline is currently empty."
        : topLeads
            .slice()
            .sort(
              (a, b) =>
                Number(b.compositeScore ?? b.score ?? 0) -
                Number(a.compositeScore ?? a.score ?? 0),
            )
            .map(
              (l: any, i: number) =>
                `${i + 1}. ${l.profile?.fullName || l.fullName || "Unknown"} - ${l.profile?.currentTitle || l.title || "Unknown"} at ${l.profile?.currentCompany || l.company || "Unknown"} | Stage: ${l.stage || "Unknown"} | Fit: ${l.fitScore ?? "?"}/10 | Intent: ${l.intentScore ?? "?"}/10`,
            )
            .join("\n");

    // Augment with search-relevant leads for the user query
    let searchContext = "";
    try {
      const STOP_WORDS = COPILOT_STOP_WORDS;
      const searchTokens = query
        .replace(/[^\p{L}\p{N}\s_@.-]/gu, " ")
        .split(/\s+/)
        .filter((w: string) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));

      if (searchTokens.length > 0) {
        const searchQuery = searchTokens.slice(0, 6).join(" ");
        const searchRes = readLeadsSummary({ search: searchQuery, limit: 15 });
        if (searchRes.leads && searchRes.leads.length > 0) {
          const searchFormatted = searchRes.leads
            .map(
              (l: any, i: number) =>
                `${i + 1}. ${l.profile?.fullName || l.fullName || "Unknown"} - ${l.profile?.currentTitle || l.title || "Unknown"} at ${l.profile?.currentCompany || l.company || "Unknown"} | Stage: ${l.stage || "Unknown"} | Fit: ${l.fitScore ?? "?"}/10 | Intent: ${l.intentScore ?? "?"}/10`,
            )
            .join("\n");
          searchContext = `\n\n### Search-Relevant Prospects for Current Query:\n${searchFormatted}`;
        }
      }
    } catch (searchError) {
      console.warn("[Copilot Chat] Search augmentation fallback:", searchError);
    }

    const systemPrompt = `${APEX_SYSTEM_PROMPT}

## Current CRM Pipeline Context
Total Leads: ${totalLeads}

### Pipeline Stage Breakdown:
${stageSummary}

### Active Leads List (Showing top 50 by qualification):
${leadsContext}${searchContext}

Answer the user's question about their CRM pipeline, leads, outreach strategy, or any sales-related query. Be direct, concise, and actionable. Format responses in markdown.`;

    const { text: reply } = await openAIText(query, systemPrompt);

    res.json({
      text: reply || "I could not generate a response. Please try again.",
    });
  } catch (error: any) {
    console.error("Error in Copilot Chat:", error);
    res.status(500).json({ error: error.message || "Chat generation failed." });
  }
});

export default router;
