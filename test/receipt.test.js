import test from "node:test";
import assert from "node:assert/strict";
import { RECEIPT_SCHEMA_VERSION, buildReceipt, formatReceiptNotice, sourcesForScope } from "../src/receipt.js";

test("sourcesForScope expands all/undefined/unknown scopes to every known source", () => {
    assert.deepEqual(sourcesForScope("all"), ["main", "archive", "documents"]);
    assert.deepEqual(sourcesForScope(undefined), ["main", "archive", "documents"]);
    assert.deepEqual(sourcesForScope("bogus"), ["main", "archive", "documents"]);
});

test("sourcesForScope narrows to a single known source", () => {
    assert.deepEqual(sourcesForScope("main"), ["main"]);
    assert.deepEqual(sourcesForScope("archive"), ["archive"]);
    assert.deepEqual(sourcesForScope("documents"), ["documents"]);
});

test("buildReceipt classifies a successful search with results as found", () => {
    const receipt = buildReceipt({
        turnId: "t1",
        scope: "all",
        startedAt: 100,
        endedAt: 140,
        resultCount: 3,
        warnings: [],
        conflicts: [],
    });
    assert.equal(receipt.schemaVersion, RECEIPT_SCHEMA_VERSION);
    assert.equal(receipt.status, "found");
    assert.equal(receipt.resultCount, 3);
    assert.deepEqual(receipt.sources, { searched: ["main", "archive", "documents"], absent: [], unavailable: [], notSearched: [] });
    assert.equal(receipt.timing.durationMs, 40);
});

test("buildReceipt classifies a successful search with zero results as absent, not silence", () => {
    const receipt = buildReceipt({ turnId: "t2", scope: "all", startedAt: 0, endedAt: 10, resultCount: 0 });
    assert.equal(receipt.status, "absent");
    assert.deepEqual(receipt.sources.absent, ["main", "archive", "documents"]);
    assert.deepEqual(receipt.sources.searched, ["main", "archive", "documents"]);
    assert.deepEqual(receipt.sources.unavailable, []);
});

test("buildReceipt classifies a thrown/aborted search as unavailable, never absence", () => {
    const receipt = buildReceipt({ turnId: "t3", scope: "all", startedAt: 0, endedAt: 5, error: true, resultCount: 9 });
    assert.equal(receipt.status, "unavailable");
    assert.equal(receipt.resultCount, 0);
    assert.deepEqual(receipt.sources.unavailable, ["main", "archive", "documents"]);
    assert.deepEqual(receipt.sources.searched, []);
    assert.deepEqual(receipt.sources.absent, []);
});

test("buildReceipt classifies service-reported conflicts as conflicting, overriding a positive result count", () => {
    const receipt = buildReceipt({ turnId: "t4", scope: "all", startedAt: 0, endedAt: 1, resultCount: 2, conflicts: ["a vs b"] });
    assert.equal(receipt.status, "conflicting");
    assert.deepEqual(receipt.conflicts, ["a vs b"]);
    assert.deepEqual(receipt.sources.searched, ["main", "archive", "documents"]);
});

test("buildReceipt marks sources outside a narrowed scope as not searched", () => {
    const receipt = buildReceipt({ turnId: "t5", scope: "main", startedAt: 0, endedAt: 1, resultCount: 1 });
    assert.deepEqual(receipt.sources.searched, ["main"]);
    assert.deepEqual(receipt.sources.notSearched, ["archive", "documents"]);
});

test("buildReceipt bounds warnings and conflicts and tolerates missing arrays", () => {
    const receipt = buildReceipt({
        turnId: "t6",
        scope: "all",
        startedAt: 0,
        endedAt: 1,
        resultCount: 0,
        warnings: ["a", "b", "c", "d", "e", "f", "g"],
        conflicts: undefined,
    });
    assert.equal(receipt.warnings.length, 5);
    assert.deepEqual(receipt.conflicts, []);
});

test("buildReceipt reports truncated flag as given", () => {
    const receipt = buildReceipt({ turnId: "t7", scope: "all", startedAt: 0, endedAt: 1, resultCount: 1, truncated: true });
    assert.equal(receipt.truncated, true);
    const untouched = buildReceipt({ turnId: "t8", scope: "all", startedAt: 0, endedAt: 1, resultCount: 1 });
    assert.equal(untouched.truncated, false);
});

test("formatReceiptNotice renders a distinct notice per status", () => {
    const absent = buildReceipt({ turnId: "t9", scope: "all", startedAt: 0, endedAt: 1, resultCount: 0 });
    assert.match(formatReceiptNotice(absent), /verified absence/);

    const unavailable = buildReceipt({ turnId: "t10", scope: "all", startedAt: 0, endedAt: 1, error: true });
    assert.match(formatReceiptNotice(unavailable), /retrieval unavailable/);

    const conflicting = buildReceipt({ turnId: "t11", scope: "all", startedAt: 0, endedAt: 1, resultCount: 1, conflicts: ["x"] });
    assert.match(formatReceiptNotice(conflicting), /conflicting evidence/);
});

test("formatReceiptNotice returns empty string for found (no separate notice needed)", () => {
    const found = buildReceipt({ turnId: "t12", scope: "all", startedAt: 0, endedAt: 1, resultCount: 2 });
    assert.equal(formatReceiptNotice(found), "");
});

test("buildReceipt tolerates non-array warnings/conflicts and a missing turnId/timing", () => {
    const receipt = buildReceipt({ scope: "all", warnings: "not-an-array", conflicts: null, resultCount: 0 });
    assert.equal(receipt.turnId, "");
    assert.deepEqual(receipt.warnings, []);
    assert.deepEqual(receipt.conflicts, []);
    assert.equal(receipt.timing.durationMs, undefined);
});

test("formatReceiptNotice appends not-searched sources when scope was narrowed", () => {
    const receipt = buildReceipt({ turnId: "t13", scope: "documents", startedAt: 0, endedAt: 1, resultCount: 0 });
    const notice = formatReceiptNotice(receipt);
    assert.match(notice, /Not searched this turn: main, archive\./);
});
