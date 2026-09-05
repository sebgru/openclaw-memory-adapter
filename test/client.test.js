import test from "node:test";
import assert from "node:assert/strict";
import { formatMemoryContext, normalizeResults, searchMemory } from "../src/client.js";

test("searches with the service GET query fields and normalizes results", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return { results: [{ text: "fact", path: "MEMORY.md", score: 0.9 }] }; } };
  };
  const results = await searchMemory("where", { endpoint: "http://memory:8080" }, fetchImpl);
  assert.equal(request.url, "http://memory:8080/search?q=where&limit=5");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.body, undefined);
  assert.deepEqual(results, [{ text: "fact", source: "MEMORY.md", score: 0.9 }]);
});

test("timeout and service failures are observable to the caller", async () => {
  await assert.rejects(() => searchMemory("x", { endpoint: "http://memory:8080" }, async () => {
    throw new Error("offline");
  }), /offline/);
});

test("malformed and empty results fail closed", () => {
  assert.deepEqual(normalizeResults({ results: [{ text: "" }, null, { nope: true }] }, 5), []);
  assert.equal(formatMemoryContext([]), "");
});

test("context marks retrieved content as reference material", () => {
  assert.match(formatMemoryContext([{ text: "fact", source: "MEMORY.md" }]), /reference only/);
});
