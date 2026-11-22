import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";

function harness(config = {}) {
  let beforePrompt;
  const warnings = [];
  const traces = [];
  plugin.register({
    pluginConfig: { endpoint: "http://memory.test", ...config },
    logger: {
      warn: (message) => warnings.push(message),
      debug: (message) => traces.push(message),
    },
    on: (name, handler) => {
      if (name === "before_prompt_build") beforePrompt = handler;
    },
    registerTool: () => {},
  });
  return { beforePrompt, warnings, traces };
}

const memoryItem = (id, text = `memory ${id}`) => ({ id, text, source: "memory", path: `memory/${id}.md`, line: 1, score: 2 });
const documentItem = (id, text = `document ${id}`) => ({ id, text, source: "document", path: `documents/${id}.md`, line: 1, score: 1 });

/** Installs a fetch stub that records requests and answers per scope. */
async function withFetch(respond, run) {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const params = new URL(url).searchParams;
    const request = { query: params.get("q"), scope: params.get("scope"), profile: params.get("profile"), signal: init?.signal };
    requests.push(request);
    return respond(request, requests);
  };
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

const ok = (payload) => ({ ok: true, json: async () => payload });
const user = { agentId: "main", trigger: "user" };

test("a triggered turn adds a parallel documents lookup next to the scope=all baseline", async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withFetch(async (request) => {
    started.push(request.scope);
    // Neither lookup answers until both have started: proves they overlap.
    if (started.length === 2) release();
    await gate;
    return ok({ results: [request.scope === "documents" ? documentItem("d1", "Kita contract text") : memoryItem("m1")] });
  }, async (requests) => {
    const { beforePrompt, traces } = harness();
    const output = await beforePrompt({ prompt: "Which Kita do the kids attend?" }, user);
    assert.deepEqual(started.sort(), ["all", "documents"]);
    assert.deepEqual(requests.map((r) => r.profile), ["prompt", "prompt"]);
    assert.match(output.prependContext, /memory m1/);
    assert.match(output.prependContext, /Kita contract text/);
    assert.deepEqual(traces.map((line) => line.replace(/\d+/g, "N")), [
      'memory-adapter: topic documents lane {"topics":N,"outcome":"merged"}',
    ]);
  });
});

test("German, Russian and English triggers each issue exactly one extra documents request", async () => {
  for (const prompt of [
    "Wann ist der TÜV für unser Auto fällig?",
    "Какая у нас ипотека на квартиру?",
    "What is my bank account balance?",
  ]) {
    await withFetch(async () => ok({ results: [memoryItem("m1")] }), async (requests) => {
      const { beforePrompt } = harness();
      await beforePrompt({ prompt }, user);
      assert.deepEqual(requests.map((r) => r.scope).sort(), ["all", "documents"], prompt);
      assert.ok(requests.every((r) => r.query === prompt));
    });
  }
});

test("an unrelated turn keeps the existing single scope=all request", async () => {
  await withFetch(async () => ok({ results: [memoryItem("m1")] }), async (requests) => {
    const { beforePrompt, traces } = harness();
    const output = await beforePrompt({ prompt: "Fix the failing unit test please" }, user);
    assert.deepEqual(requests.map((r) => r.scope), ["all"]);
    assert.match(output.prependContext, /memory m1/);
    assert.deepEqual(traces, []);
  });
});

test("topicTrigger.enabled=false and disabledCategories suppress the documents lookup", async () => {
  for (const topicTrigger of [{ enabled: false }, { disabledCategories: ["school", "family"] }]) {
    await withFetch(async () => ok({ results: [memoryItem("m1")] }), async (requests) => {
      const { beforePrompt } = harness({ topicTrigger });
      await beforePrompt({ prompt: "Which school do the kids attend?" }, user);
      assert.deepEqual(requests.map((r) => r.scope), ["all"]);
    });
  }
});

test("configured entity aliases trigger the lookup; the same prompt does not trigger without them", async () => {
  const prompt = "What did Zoë say about the weekend?";
  await withFetch(async () => ok({ results: [] }), async (requests) => {
    await harness().beforePrompt({ prompt }, user);
    assert.deepEqual(requests.map((r) => r.scope), ["all"]);
  });
  await withFetch(async () => ok({ results: [] }), async (requests) => {
    const { beforePrompt } = harness({ topicTrigger: { entityAliases: { family: ["Zoë"] } } });
    await beforePrompt({ prompt }, user);
    assert.deepEqual(requests.map((r) => r.scope).sort(), ["all", "documents"]);
  });
});

test("reserved document slots keep documents in the injected context", async () => {
  await withFetch(async (request) => ok({
    results: request.scope === "documents"
      ? [documentItem("d1"), documentItem("d2"), documentItem("d3")]
      : ["m1", "m2", "m3", "m4", "m5"].map((id) => memoryItem(id)),
  }), async () => {
    const { beforePrompt } = harness({ maxResults: 5 });
    const output = await beforePrompt({ prompt: "Where do we live? Our home address please." }, user);
    const lines = output.prependContext.split("\n").filter((line) => /^\d+\./.test(line));
    assert.equal(lines.length, 5);
    assert.match(lines[0], /memory m1/);
    assert.match(lines[2], /memory m3/);
    assert.match(lines[3], /document d1/);
    assert.match(lines[4], /document d2/);
  });
  await withFetch(async (request) => ok({
    results: request.scope === "documents"
      ? [documentItem("d1"), documentItem("d2")]
      : ["m1", "m2", "m3", "m4", "m5"].map((id) => memoryItem(id)),
  }), async () => {
    const { beforePrompt } = harness({ maxResults: 5, topicTrigger: { documentSlots: 1 } });
    const output = await beforePrompt({ prompt: "Our home address please." }, user);
    assert.match(output.prependContext, /memory m4/);
    assert.match(output.prependContext, /document d1/);
    assert.doesNotMatch(output.prependContext, /document d2/);
  });
});

test("a documents lookup failure is soft: baseline context stays and the fallback is disclosed", async () => {
  await withFetch(async (request) => {
    if (request.scope === "documents") throw new Error("documents lane down");
    return ok({ results: [memoryItem("m1")] });
  }, async () => {
    const { beforePrompt, traces, warnings } = harness();
    const output = await beforePrompt({ prompt: "Which school do the kids attend?" }, user);
    assert.match(output.prependContext, /memory m1/);
    assert.match(output.prependContext, /focused document search .* unavailable/);
    assert.match(output.prependContext, /do not claim that no matching document exists/);
    assert.equal(warnings.length, 1);
    assert.deepEqual(traces.map((line) => line.replace(/\d+/g, "N")), [
      'memory-adapter: topic documents lane {"topics":N,"outcome":"unavailable"}',
    ]);
  });
});

test("an HTTP error from the documents lane is also soft, and receipts disclose partial coverage", async () => {
  await withFetch(async (request) => (request.scope === "documents"
    ? { ok: false, status: 503, json: async () => ({}) }
    : ok({ results: [memoryItem("m1")], coverage: { main: "searched", archive: "searched", documents: "searched" } })), async () => {
    const { beforePrompt, traces } = harness({ turnReceipts: true });
    const output = await beforePrompt({ prompt: "Which school do the kids attend?" }, { ...user, runId: "run-1" });
    assert.match(output.prependContext, /memory m1/);
    const receipt = traces.find((line) => line.includes("receipt"));
    assert.match(receipt, /"status":"found"/);
    assert.match(receipt, /"partialCoverage":true/);
    assert.match(output.prependContext, /Source coverage for this turn is unverified/);
  });
});

test("a failed documents lane with zero baseline results is unverified, never a verified absence", async () => {
  await withFetch(async (request) => {
    if (request.scope === "documents") throw new Error("documents lane down");
    return ok({ results: [], coverage: { main: "searched", archive: "searched", documents: "searched" } });
  }, async () => {
    const { beforePrompt, traces } = harness({ turnReceipts: true });
    const output = await beforePrompt({ prompt: "Which school do the kids attend?" }, { ...user, runId: "run-2" });
    assert.match(traces.find((line) => line.includes("receipt")), /"status":"unverified"/);
    assert.match(output.prependContext, /not a verified absence|This is not a verified absence/);
    assert.doesNotMatch(output.prependContext, /This is a verified absence/);
  });
});

test("receipt mode with a healthy documents lane merges results and stays fully covered", async () => {
  await withFetch(async (request) => ok({
    results: [request.scope === "documents" ? documentItem("d1") : memoryItem("m1")],
    coverage: { main: "searched", archive: "searched", documents: "searched" },
  }), async () => {
    const { beforePrompt, traces } = harness({ turnReceipts: true });
    const output = await beforePrompt({ prompt: "Which school do the kids attend?" }, { ...user, runId: "run-3" });
    assert.match(output.prependContext, /memory m1/);
    assert.match(output.prependContext, /document d1/);
    const receipt = traces.find((line) => line.includes("receipt"));
    assert.match(receipt, /"resultCount":2/);
    assert.match(receipt, /"partialCoverage":false/);
  });
});

test("a hung documents lane is aborted at the configured timeout, not the six-second budget", async () => {
  await withFetch(async (request) => {
    if (request.scope !== "documents") return ok({ results: [memoryItem("m1")] });
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }, async () => {
    const { beforePrompt } = harness({ timeoutMs: 300, topicTrigger: { timeoutMs: 5000 } });
    const startedAt = Date.now();
    const output = await beforePrompt({ prompt: "Which school do the kids attend?" }, user);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 250 && elapsed < 1500, `elapsed ${elapsed}`);
    assert.match(output.prependContext, /memory m1/);
    assert.match(output.prependContext, /focused document search/);
  });
});

test("topicTrigger.timeoutMs can shorten the documents lane below the adapter timeout", async () => {
  await withFetch(async (request) => {
    if (request.scope !== "documents") return ok({ results: [memoryItem("m1")] });
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }, async () => {
    const { beforePrompt } = harness({ timeoutMs: 4000, topicTrigger: { timeoutMs: 250 } });
    const startedAt = Date.now();
    await beforePrompt({ prompt: "Which school do the kids attend?" }, user);
    assert.ok(Date.now() - startedAt < 1500);
  });
});

test("a baseline failure still produces the unavailable notice and does not leak the documents lane", async () => {
  await withFetch(async (request) => {
    if (request.scope === "documents") return ok({ results: [documentItem("d1")] });
    throw new Error("baseline down");
  }, async () => {
    const { beforePrompt, warnings } = harness();
    const output = await beforePrompt({ prompt: "Which school do the kids attend?" }, user);
    assert.match(output.prependContext, /Memory retrieval unavailable/);
    assert.equal(warnings.length, 1);
  });
});

test("a baseline failure aborts the pending documents lane immediately", async () => {
  await withFetch(async (request) => {
    if (request.scope !== "documents") throw new Error("baseline down");
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }, async (requests) => {
    const { beforePrompt } = harness({ timeoutMs: 5000 });
    const startedAt = Date.now();
    const output = await beforePrompt({ prompt: "Which school do the kids attend?" }, user);
    const documents = requests.find((r) => r.scope === "documents");
    assert.match(output.prependContext, /Memory retrieval unavailable/);
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(documents.signal.aborted, true, "documents request cancelled without waiting for its timeout");
  });
});

test("internal turns and disallowed chats never run either lane (B.1 and privacy preserved)", async () => {
  await withFetch(async () => ok({ results: [memoryItem("m1")] }), async (requests) => {
    const prompt = "Which school do the kids attend?";
    const { beforePrompt } = harness();
    for (const ctx of [
      { agentId: "main", trigger: "heartbeat" },
      { agentId: "main", trigger: "cron" },
      { agentId: "main", trigger: "memory" },
      { agentId: "main", trigger: "user", inputProvenance: { kind: "inter_session" } },
      { agentId: "main", trigger: "user", inputProvenance: { kind: "internal_system" } },
    ]) {
      assert.equal(await beforePrompt({ prompt }, ctx), undefined);
    }
    const restricted = harness({ allowedChatTypes: ["direct"] });
    assert.equal(await restricted.beforePrompt({ prompt }, { ...user, chatType: "group" }), undefined);
    assert.equal(requests.length, 0);
    await beforePrompt({ prompt }, user);
    assert.equal(requests.length, 2);
  });
});

test("document evidence from the topic lane suppresses the entity follow-up", async () => {
  await withFetch(async (request) => ok({
    results: request.scope === "documents"
      ? [documentItem("d1", "Contract with Quill Sample about the school")]
      : [memoryItem("m1")],
  }), async (requests) => {
    const { beforePrompt } = harness();
    await beforePrompt({ prompt: 'Which school does "Quill Sample" attend?' }, user);
    assert.equal(requests.length, 2);
  });
});

test("topic lane and entity follow-up together stay within baseline + documents + one follow-up", async () => {
  await withFetch(async (request) => ok({
    results: request.query === "Quill Sample" ? [memoryItem("m9", "Quill Sample profile")] : [memoryItem("m1")],
  }), async (requests) => {
    const { beforePrompt } = harness();
    const output = await beforePrompt({ prompt: 'Which school does "Quill Sample" attend?' }, user);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.slice(0, 2).map((r) => r.scope).sort(), ["all", "documents"]);
    assert.match(output.prependContext, /Quill Sample profile/);
  });
});

test("the document reservation never evicts the entity follow-up evidence", async () => {
  await withFetch(async (request) => {
    if (request.scope === "documents") return ok({ results: [documentItem("d1"), documentItem("d2")] });
    if (request.query === "Quill Sample") return ok({ results: [{ ...memoryItem("e1", "Quill Sample profile"), score: 0.5 }] });
    return ok({ results: ["m1", "m2", "m3", "m4"].map((id) => memoryItem(id)) });
  }, async (requests) => {
    const { beforePrompt } = harness();
    const output = await beforePrompt({ prompt: 'Which school does "Quill Sample" attend?' }, user);
    assert.equal(requests.length, 3);
    assert.match(output.prependContext, /Quill Sample profile/);
    assert.match(output.prependContext, /document d1/);
    assert.match(output.prependContext, /document d2/);
    assert.match(output.prependContext, /memory m2/);
    assert.doesNotMatch(output.prependContext, /memory m3/);
  });
});

test("fresh documents clear a baseline low-confidence flag; an empty lane keeps it", async () => {
  await withFetch(async (request) => ok(request.scope === "documents"
    ? { results: [documentItem("d1")] }
    : { results: [memoryItem("m1")], low_confidence: true }), async () => {
    const output = await harness().beforePrompt({ prompt: "Which school do the kids attend?" }, user);
    assert.doesNotMatch(output.prependContext, /flagged low confidence/);
  });
  await withFetch(async (request) => ok(request.scope === "documents"
    ? { results: [] }
    : { results: [memoryItem("m1")], low_confidence: true }), async () => {
    const output = await harness().beforePrompt({ prompt: "Which school do the kids attend?" }, user);
    assert.match(output.prependContext, /flagged low confidence/);
  });
});

test("logs carry only counts: no prompt text, categories or alias names", async () => {
  await withFetch(async () => ok({ results: [memoryItem("m1")] }), async () => {
    const { beforePrompt, traces, warnings } = harness({ topicTrigger: { entityAliases: { family: ["Zoë"] } } });
    await beforePrompt({ prompt: "What did Zoë say about school?" }, user);
    const logged = [...traces, ...warnings].join("\n");
    assert.doesNotMatch(logged, /Zoë|zoe|school|family/i);
  });
});
