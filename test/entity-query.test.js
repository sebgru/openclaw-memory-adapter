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
  assert.equal(extractEntityTarget('Please verify "Riley Sample".'), "Riley Sample");
  assert.equal(extractEntityTarget("Did Casey Example work at Example Corp.?"), "Casey Example");
  assert.equal(extractEntityTarget("Find mail for person@example.test"), "person@example.test");
  assert.equal(extractEntityTarget("Open memory/facts/owner.json"), "memory/facts/owner.json");
  assert.equal(extractEntityTarget("Where is Riley?"), undefined);
  assert.equal(extractEntityTarget("Please check Riley aka Jordan."), "Riley");
  assert.equal(extractEntityTarget('Search "Riley" (also known as "Jordan").'), "Riley");
  assert.equal(extractEntityTarget("Does OpenClaw support that?"), undefined);
  assert.equal(extractEntityTarget(undefined), undefined);
  assert.equal(extractEntityTarget(' "   " '), undefined);
  assert.equal(extractEntityTarget(' "foo.md" '), "foo.md");
  assert.equal(extractEntityTarget(`"${"x".repeat(161)}"`), undefined);
  assert.equal(extractEntityTarget(`${"x".repeat(4001)} "Riley Sample"`), undefined);
});

test("expands only an explicitly linked alias from the current prompt", () => {
  assert.equal(expandLinkedAlias("Please check Riley aka Jordan.", "Riley"), "Riley Jordan");
  assert.equal(expandLinkedAlias('Look up "Riley" also known as "Jordan".', "Riley"), "Riley Jordan");
  assert.equal(expandLinkedAlias("Riley and Jordan are colleagues.", "Riley"), undefined);
  assert.equal(expandLinkedAlias("Riley aka Jordan", "Jordan"), undefined);
  assert.equal(expandLinkedAlias("Riley aka Jordan", undefined), undefined);
  assert.equal(expandLinkedAlias(undefined, "Riley"), undefined);
});

test("entity evidence is case-insensitive and may be in the result path", () => {
  assert.equal(hasEntityEvidence([{ text: "RILEY SAMPLE" }], "Riley Sample"), true);
  assert.equal(hasEntityEvidence([{ text: "unrelated", path: "memory/facts/Riley.md" }], "Riley"), true);
  assert.equal(hasEntityEvidence([{ text: "unrelated" }], "Riley"), false);
  assert.equal(hasEntityEvidence([{ text: "Riley" }], ""), false);
  assert.equal(hasEntityEvidence([{ text: "Riley" }], undefined), false);
  assert.equal(hasEntityEvidence(null, "Riley"), false);
  assert.equal(hasEntityEvidence([{ text: null, path: 1, source: "memory/Riley" }], "Riley"), true);
});

test("classifies file/path targets for direct document lookup without routing emails", () => {
  assert.equal(isDocumentIdentifier("memory/facts/person.md"), true);
  assert.equal(isDocumentIdentifier("report.pdf"), true);
  assert.equal(isDocumentIdentifier("person@example.test"), false);
  assert.equal(isDocumentIdentifier("Riley Sample"), false);
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
