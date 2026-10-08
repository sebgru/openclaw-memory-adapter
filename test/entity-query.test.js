import test from "node:test";
import assert from "node:assert/strict";
import {
  extractEntityTarget,
  expandLinkedAlias,
  hasEntityEvidence,
  isDocumentIdentifier,
  mergeSearchResponses,
} from "../src/entity-query.js";

test("extracts explicit, structured, and multi-token targets without guessing first names", () => {
  assert.equal(extractEntityTarget('Please verify "Katja Grünwedel".'), "Katja Grünwedel");
  assert.equal(extractEntityTarget("Did Anna Schmidt work at TomTom?"), "Anna Schmidt");
  assert.equal(extractEntityTarget("Find mail for anna@example.org"), "anna@example.org");
  assert.equal(extractEntityTarget("Open memory/facts/sebastian.json"), "memory/facts/sebastian.json");
  assert.equal(extractEntityTarget("Where is Anna?"), undefined);
  assert.equal(extractEntityTarget("Please check Katja aka Ekaterina."), "Katja");
  assert.equal(extractEntityTarget('Search "Katja" (also known as "Ekaterina").'), "Katja");
  assert.equal(extractEntityTarget("Does OpenClaw support that?"), undefined);
  assert.equal(extractEntityTarget(undefined), undefined);
  assert.equal(extractEntityTarget(' "   " '), undefined);
  assert.equal(extractEntityTarget(' "foo.md" '), "foo.md");
  assert.equal(extractEntityTarget(`"${"x".repeat(161)}"`), undefined);
  assert.equal(extractEntityTarget(`${"x".repeat(4001)} "Katja Grünwedel"`), undefined);
});

test("expands only an explicitly linked alias from the current prompt", () => {
  assert.equal(expandLinkedAlias("Please check Katja aka Ekaterina.", "Katja"), "Katja Ekaterina");
  assert.equal(expandLinkedAlias('Look up "Katja" also known as "Ekaterina".', "Katja"), "Katja Ekaterina");
  assert.equal(expandLinkedAlias("Katja and Ekaterina are colleagues.", "Katja"), undefined);
  assert.equal(expandLinkedAlias("Katja aka Ekaterina", "Ekaterina"), undefined);
  assert.equal(expandLinkedAlias("Katja aka Ekaterina", undefined), undefined);
  assert.equal(expandLinkedAlias(undefined, "Katja"), undefined);
});

test("entity evidence is case-insensitive and may be in the result path", () => {
  assert.equal(hasEntityEvidence([{ text: "katja GRÜNWEDEL" }], "Katja Grünwedel"), true);
  assert.equal(hasEntityEvidence([{ text: "unrelated", path: "memory/facts/Katja.md" }], "Katja"), true);
  assert.equal(hasEntityEvidence([{ text: "unrelated" }], "Katja"), false);
  assert.equal(hasEntityEvidence([{ text: "Katja" }], ""), false);
  assert.equal(hasEntityEvidence([{ text: "Katja" }], undefined), false);
  assert.equal(hasEntityEvidence(null, "Katja"), false);
  assert.equal(hasEntityEvidence([{ text: null, path: 1, source: "memory/Katja" }], "Katja"), true);
});

test("classifies file/path targets for direct document lookup without routing emails", () => {
  assert.equal(isDocumentIdentifier("memory/facts/person.md"), true);
  assert.equal(isDocumentIdentifier("report.pdf"), true);
  assert.equal(isDocumentIdentifier("anna@example.org"), false);
  assert.equal(isDocumentIdentifier("Katja Grünwedel"), false);
  assert.equal(isDocumentIdentifier(undefined), false);
});

test("merges targeted results, deduplicates stable identities, and combines coverage conservatively", () => {
  const merged = mergeSearchResponses(
    {
      results: [
        { id: "same", text: "baseline", score: 0.4 },
        { id: "base", text: "base", score: 0.2 },
      ],
      warnings: ["partial"],
      conflicts: [],
      coverage: { main: "searched", archive: "searched", documents: "searched" },
    },
    {
      results: [
        { id: "same", text: "duplicate", score: 0.9 },
        { id: "target", text: "target", score: 0.8 },
      ],
      warnings: ["partial", "lexical fallback"],
      conflicts: ["conflict"],
      coverage: { main: "searched", archive: "unavailable", documents: "searched" },
    },
    3,
  );

  assert.deepEqual(merged.results.map((item) => item.id), ["target", "same", "base"]);
  assert.deepEqual(merged.warnings, ["partial", "lexical fallback"]);
  assert.deepEqual(merged.conflicts, ["conflict"]);
  assert.deepEqual(merged.coverage, {
    main: "searched",
    archive: "searched",
    documents: "searched",
  });
});

test("missing coverage from either query remains unknown instead of being inferred", () => {
  const merged = mergeSearchResponses(
    { results: [], coverage: { main: "searched", archive: "searched", documents: "searched" } },
    { results: [] },
  );
  assert.deepEqual(merged.coverage, {});
});

test("merging preserves unknown coverage, optional metadata, and unlocated chunks", () => {
  assert.deepEqual(mergeSearchResponses({ results: [{ text: "one" }] }, { results: [{ text: "two" }] }), {
    results: [{ text: "one" }, { text: "two" }], warnings: [], conflicts: [],
  });
  assert.deepEqual(mergeSearchResponses(
    { results: [{ path: "a.md", line: 1 }, { path: "a.md", line: 1 }] },
    { results: [{ path: "a.md", line: 1 }, { text: "third" }] },
  ).results, [{ path: "a.md", line: 1 }, { text: "third" }]);
  assert.deepEqual(mergeSearchResponses(
    { results: [], coverage: { main: "searched", archive: "not_searched" } },
    { results: [], coverage: { main: "searched", archive: "searched" } },
  ).coverage, { main: "searched", archive: "searched" });
  assert.deepEqual(mergeSearchResponses(
    { results: [], coverage: { main: "searched", archive: "searched", documents: "searched" } },
    { results: [], coverage: { main: "not_searched", archive: "not_searched", documents: "searched" } },
  ).coverage, { main: "searched", archive: "searched", documents: "searched" });
  assert.deepEqual(mergeSearchResponses(
    { results: [], coverage: { main: "unavailable", archive: "not_searched" } },
    { results: [], coverage: { main: "unavailable", archive: "not_searched" } },
  ).coverage, { main: "unavailable", archive: "not_searched" });
  assert.deepEqual(mergeSearchResponses(
    { results: [], coverage: { main: "searched" } },
    { results: [], coverage: { main: "searched" } },
  ).coverage, { main: "searched" });
  assert.deepEqual(mergeSearchResponses({ results: [], coverage: null }, { results: [], coverage: {} }).coverage, {});
  assert.deepEqual(mergeSearchResponses({}, {}).results, []);
});
