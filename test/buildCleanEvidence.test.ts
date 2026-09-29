import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCleanEvidence } from "../server/leadSearch/stages/extractStage.js";

test("buildCleanEvidence preserves up to 3200 chars for upgraded items", () => {
  const longText = "A".repeat(4000);
  const upgradedItem = {
    url: "https://example.com/alice",
    title: "Alice Smith",
    content: longText,
    sourceProvider: "brightdata_search",
    _evidenceUpgraded: true,
  };

  const evidence = buildCleanEvidence(upgradedItem);
  assert.ok(evidence.includes("LINK: https://example.com/alice"));
  assert.ok(evidence.includes("[BRIGHTDATA SNIPPET]"));
  assert.ok(!evidence.includes("[TAVILY SNIPPET]"));
  // Upgraded evidence keeps the larger 3200-char window
  assert.ok(evidence.includes("A".repeat(3200) + "..."));
  assert.ok(!evidence.includes("A".repeat(3201)));
});

test("buildCleanEvidence caps non-upgraded items at 1500 chars with default [TAVILY SNIPPET]", () => {
  const longText = "B".repeat(2000);
  const regularItem = {
    url: "https://example.com/bob",
    title: "Bob Jones",
    content: longText,
    sourceProvider: "tavily",
    _evidenceUpgraded: false,
  };

  const evidence = buildCleanEvidence(regularItem);
  assert.ok(evidence.includes("LINK: https://example.com/bob"));
  assert.ok(evidence.includes("[TAVILY SNIPPET]"));
  assert.ok(!evidence.includes("[BRIGHTDATA SNIPPET]"));
  // Must be capped at 1500
  assert.ok(evidence.includes("B".repeat(1500) + "..."));
  assert.ok(!evidence.includes("B".repeat(1501)));
});
