import test from "node:test";
import assert from "node:assert/strict";
import {
  createTopicDetector,
  detectTopics,
  foldText,
  mergeDocumentLane,
  topicTriggerSettings,
} from "../src/topic-trigger.js";
import { DEFAULT_LEXICON } from "../src/topic-lexicon.js";

// Synthetic prompts only; every row names the categories it must trigger.
const POSITIVE = [
  // family
  ["en", "How old is my daughter now?", ["family"]],
  ["en", "Remind me what my parents gave our kids", ["family"]],
  ["de", "Wie heißt meine Tochter eigentlich genau?", ["family"]],
  ["de", "Die Töchter und Söhne der Familie", ["family"]],
  ["de", "Mein Mann und meine Frau haben Geburtstag", ["family"]],
  ["ru", "Как зовут мою дочку и сына?", ["family"]],
  ["ru", "Скажи, когда день рождения у жены и мужа", ["family"]],
  ["ru", "Подарок для бабушки и дедушки", ["family"]],
  // home
  ["en", "What is our home address?", ["home"]],
  ["en", "Where do we live and what is the mortgage rate", ["home"]],
  ["de", "Wie hoch sind die Nebenkosten und die Miete?", ["home"]],
  ["de", "Wo wohnen wir noch gleich", ["home"]],
  ["ru", "Какая у нас ипотека на квартиру?", ["home"]],
  ["ru", "Договор аренды и коммунальные платежи", ["home"]],
  // vehicle
  ["en", "When is the next inspection for my license plate? mileage too", ["vehicle"]],
  ["en", "Which tires fit the car", ["vehicle"]],
  ["de", "Wann ist der TÜV für unser Auto fällig?", ["vehicle"]],
  ["de", "Tuev, Fuehrerschein und Zulassungsbescheinigung", ["vehicle"]],
  ["de", "Das Fahrzeugschein-Foto vom Pkw", ["vehicle"]],
  ["ru", "Номерной знак машины и техосмотр", ["vehicle"]],
  ["ru", "Какой пробег у нашей машины", ["vehicle"]],
  // finance
  ["en", "What is my bank account balance?", ["finance"]],
  ["en", "Where is the 2025 tax return and the loan statement", ["finance"]],
  ["de", "Mein Girokonto bei der Sparkasse", ["finance"]],
  ["de", "Steuererklärung, Steuerbescheid und Überweisung", ["finance"]],
  ["ru", "На каком банковском счете лежат деньги?", ["finance"]],
  ["ru", "Налоговая декларация и кредит", ["finance"]],
  // insurance
  ["en", "Which insurer holds the policy number?", ["insurance"]],
  ["de", "Haftpflichtversicherung und Hausratversicherung kündigen", ["insurance", "work"]],
  ["de", "Wie hoch ist die Selbstbeteiligung bei der Vollkasko?", ["insurance"]],
  ["ru", "Где лежит страховой полис и франшиза?", ["insurance"]],
  // school
  ["en", "Which school and daycare do the kids attend?", ["school", "family"]],
  ["en", "The teacher asked about homework", ["school"]],
  ["de", "Anmeldung für die Grundschule und die Kita", ["school"]],
  ["de", "Der Lehrer will den Elternabend verschieben", ["school"]],
  ["ru", "Когда начинается школа и детский сад?", ["school"]],
  ["ru", "Учительница дала домашнее задание", ["school"]],
  // work
  ["en", "What is my salary and who is my employer?", ["work"]],
  ["en", "Send the employment contract to my colleagues", ["work"]],
  ["de", "Die Gehaltsabrechnung vom Arbeitgeber fehlt", ["work"]],
  ["de", "Mein Bruttogehalt und der Arbeitsvertrag", ["work"]],
  ["ru", "Моя зарплата и трудовой договор", ["work"]],
  ["ru", "Работодатель уволил коллегу", ["work"]],
  // health
  ["en", "When is my next doctor's appointment?", ["health"]],
  ["en", "The dentist said to renew the prescription", ["health"]],
  ["de", "Der Zahnarzt und der Kinderarzt haben Termine", ["health"]],
  ["de", "Die Krankschreibung und der Impfpass", ["health"]],
  ["ru", "Мне надо к врачу, болит зуб", ["health"]],
  ["ru", "Прививки и аптека рядом", ["health"]],
];

test("default lexicon triggers the expected categories in German, English and Russian", () => {
  for (const [language, prompt, expected] of POSITIVE) {
    const actual = detectTopics(prompt);
    for (const category of expected) {
      assert.ok(actual.includes(category), `${language}: "${prompt}" should trigger ${category}, got ${actual}`);
    }
  }
});

test("every default category is exercised in every language", () => {
  const covered = new Set();
  for (const [language, , categories] of POSITIVE) {
    for (const category of categories) covered.add(`${language}:${category}`);
  }
  for (const category of Object.keys(DEFAULT_LEXICON)) {
    for (const language of ["en", "de", "ru"]) {
      assert.ok(covered.has(`${language}:${category}`), `missing ${language} sample for ${category}`);
    }
  }
});

test("inflected forms of one stem trigger the same category", () => {
  const forms = {
    school: ["Schüler", "Schülerin", "Schülern", "Klassenlehrerin", "Realschule", "школьник", "школой", "teachers"],
    family: ["Söhne", "Sohnes", "Enkelin", "Verwandtschaft", "сыновья", "сыном", "ребёнку", "родителям"],
    health: ["Hausarzt", "Ärztin", "Ärzte", "Krankenhaus", "Zähne", "врачом", "больницу", "лекарства"],
    home: ["Wohnung", "Wohnungen", "Vermieterin", "квартире", "квартирой", "арендой"],
    insurance: ["versichert", "Versicherungen", "Autoversicherung", "страховки", "страховой", "insured"],
    work: ["Gehälter", "Gehaltserhöhung", "Kollegen", "Kollegin", "зарплату", "зарплатой", "colleagues"],
    finance: ["Konten", "Girokonto", "Kreditkarte", "банка", "банком", "налогов", "loans"],
    vehicle: ["Fahrzeuge", "Fahrzeugs", "автомобиля", "автомобилем", "vehicles", "driving licence"],
  };
  for (const [category, words] of Object.entries(forms)) {
    for (const word of words) {
      assert.ok(detectTopics(`Bitte zu ${word} nachsehen`).includes(category), `${word} -> ${category}`);
    }
  }
});

test("unrelated and technical text does not trigger", () => {
  const unrelated = [
    "question",
    'Find "Quill Sample".',
    "Please check Quill aka Juniper.",
    "run the diagnostics and restart the gateway",
    "openclaw doctor reports a health check failure",
    "the child session of the subagent timed out",
    "what kind of model family is this?",
    "refactor the auto-merge workflow",
    "Fix the failing unit test in client.js",
    "multi-tenant tenant isolation for the cron job",
    "Die Steuerung des Roboters funktioniert",
    "Er hat die Hand gehalten und wir haben gearbeitet",
    "Das lohnt sich nicht. In der Praxis klappt das",
    "Wie ist das Wetter in Beispielstadt?",
    "Сделай анализ данных и резюме текста",
    "Привет, как дела?",
    "",
  ];
  for (const prompt of unrelated) {
    assert.deepEqual(detectTopics(prompt), [], prompt);
  }
  assert.deepEqual(detectTopics(undefined), []);
  assert.deepEqual(detectTopics(42), []);
});

test("matching is whole-word: lexicon terms inside longer words do not trigger", () => {
  assert.deepEqual(detectTopics("current rental-free carpet"), ["home"]);
  assert.deepEqual(detectTopics("a scarcely carbonated carton"), []);
  assert.deepEqual(detectTopics("rented the scar"), []);
});

test("only the first 4000 characters of a prompt are inspected", () => {
  const padding = "x ".repeat(2100);
  assert.deepEqual(detectTopics(`${padding}my doctor`), []);
  assert.deepEqual(detectTopics(`my doctor ${padding}`), ["health"]);
});

test("foldText folds case, diacritics, sharp s, curly quotes and umlaut digraphs", () => {
  assert.equal(foldText("Kündigung"), foldText("Kuendigung"));
  assert.equal(foldText("STRASSE"), foldText("Straße"));
  assert.equal(foldText("Ёлка"), foldText("елка"));
  assert.equal(foldText("Mira’s"), "mira's");
});

test("entity aliases come from configuration, match whole words and possessives", () => {
  const config = { entityAliases: { family: ["Zoë", "Mira Muster"], school: ["Example Grundschule"] } };
  assert.deepEqual(detectTopics("What did Zoë say yesterday?"), []);
  assert.deepEqual(detectTopics("What did Zoë say yesterday?", config), ["family"]);
  assert.deepEqual(detectTopics("Zoës Geburtstag ist bald", config), ["family"]);
  assert.deepEqual(detectTopics("Zoë's birthday is soon", config), ["family"]);
  assert.deepEqual(detectTopics("Zoë’s birthday is soon", config), ["family"]);
  assert.deepEqual(detectTopics("Was ist mit Mira   Muster?", config), ["family"]);
  assert.deepEqual(detectTopics("Anruf bei der Example Grundschule", config), ["school"]);
  assert.deepEqual(detectTopics("Zoëland and Zoeshop", config), []);
});

test("alias wildcards cover inflected names that the possessive rule does not", () => {
  const config = { entityAliases: { family: ["Зорвек*", "*vex"] } };
  assert.deepEqual(detectTopics("Позвони Зорвеку и Зорвеком", config), ["family"]);
  assert.deepEqual(detectTopics("ask Zorvex", config), ["family"]);
  assert.deepEqual(detectTopics("ask Zorvexo", config), []);
});

test("extraTerms extend default categories and can define custom categories", () => {
  const config = {
    extraTerms: {
      vehicle: ["camper*", "e-bike"],
      pets: ["Biscuit", "hamster*", "x", "y".repeat(65), 7, null],
      "Not A Name": ["bogus"],
    },
  };
  assert.deepEqual(detectTopics("Der Camper braucht Reifen", config), ["vehicle"]);
  assert.deepEqual(detectTopics("my e-bike", config), ["vehicle"]);
  assert.deepEqual(detectTopics("Feed Biscuit and the hamsters", config), ["pets"]);
  assert.deepEqual(detectTopics("bogus", config), []);
  assert.deepEqual(detectTopics("x", config), []);
});

test("disabledCategories switch a default category off; malformed config is ignored", () => {
  const prompt = "Wie hoch ist die Kfz-Versicherung?";
  assert.deepEqual(detectTopics(prompt), ["vehicle", "insurance"]);
  assert.deepEqual(detectTopics(prompt, { disabledCategories: ["vehicle"] }), ["insurance"]);
  assert.deepEqual(detectTopics(prompt, { disabledCategories: "vehicle" }), ["vehicle", "insurance"]);
  assert.deepEqual(detectTopics(prompt, { extraTerms: [], entityAliases: "nope", disabledCategories: [] }), ["vehicle", "insurance"]);
  assert.deepEqual(detectTopics("my doctor", { extraTerms: { health: "not-a-list" } }), ["health"]);
  assert.deepEqual(detectTopics(prompt, []), ["vehicle", "insurance"]);
});

test("detectors are compiled once per configuration object", () => {
  const config = { entityAliases: { family: ["Zoë"] } };
  assert.deepEqual(detectTopics("Zoë", config), ["family"]);
  config.entityAliases.family.push("Mira");
  // Cached detector: mutation after first use is intentionally not picked up.
  assert.deepEqual(detectTopics("Mira", config), []);
  assert.deepEqual(createTopicDetector(config)("Mira"), ["family"]);
});

test("a category without any usable term compiles to nothing", () => {
  const detect = createTopicDetector({ extraTerms: { empty: ["x"] }, disabledCategories: Object.keys(DEFAULT_LEXICON) });
  assert.deepEqual(detect("anything x"), []);
});

test("topicTriggerSettings applies defaults and bounds", () => {
  assert.deepEqual(topicTriggerSettings(undefined), { enabled: true, documentSlots: 2, timeoutMs: undefined });
  assert.deepEqual(topicTriggerSettings({ enabled: false, documentSlots: 4, timeoutMs: 800 }), {
    enabled: false,
    documentSlots: 4,
    timeoutMs: 800,
  });
  assert.equal(topicTriggerSettings({ documentSlots: 0 }).documentSlots, 2);
  assert.equal(topicTriggerSettings({ documentSlots: 11 }).documentSlots, 2);
  assert.equal(topicTriggerSettings({ documentSlots: 1.5 }).documentSlots, 2);
  assert.equal(topicTriggerSettings({ timeoutMs: 100 }).timeoutMs, undefined);
  assert.equal(topicTriggerSettings("nope").enabled, true);
});

const item = (id, source = "memory", extra = {}) => ({ id, text: `text ${id}`, source, score: 1, ...extra });

test("mergeDocumentLane keeps baseline order and reserves document slots", () => {
  const baseline = { results: ["a", "b", "c", "d", "e"].map((id) => item(id)), warnings: [], conflicts: [] };
  const documents = { results: ["x", "y", "z"].map((id) => item(id, "document")), warnings: [], conflicts: [] };
  const merged = mergeDocumentLane(baseline, documents, 5, 2);
  assert.deepEqual(merged.results.map((r) => r.id), ["a", "b", "c", "x", "y"]);
  assert.deepEqual(mergeDocumentLane(baseline, documents, 5, 1).results.map((r) => r.id), ["a", "b", "c", "d", "x"]);
});

test("mergeDocumentLane counts documents already in the baseline and fills free slots", () => {
  const baseline = {
    results: [item("a"), item("doc1", "document"), item("b")],
    warnings: [],
    conflicts: [],
  };
  const documents = { results: [item("doc1", "document"), item("x", "document"), item("y", "document")], warnings: [], conflicts: [] };
  // One document is already present; two free slots remain, both filled, duplicate skipped.
  assert.deepEqual(mergeDocumentLane(baseline, documents, 5, 2).results.map((r) => r.id), ["a", "doc1", "b", "x", "y"]);
  // Reserve already satisfied and no free slot: baseline untouched.
  const full = { results: [item("a"), item("doc1", "document"), item("b")], warnings: [], conflicts: [] };
  assert.deepEqual(mergeDocumentLane(full, documents, 3, 1).results.map((r) => r.id), ["a", "doc1", "b"]);
});

test("mergeDocumentLane dedupes by id, location and text and never exceeds maxResults", () => {
  const baseline = {
    results: [
      { text: "same text", source: "memory" },
      { text: "loc", source: "memory", path: "p.md", line: 3 },
    ],
    warnings: [],
    conflicts: [],
  };
  const documents = {
    results: [
      { text: "same text", source: "document" },
      { text: "other", source: "memory", path: "p.md", line: 3 },
      { text: "fresh doc", source: "document", path: "d.md", line: 9 },
    ],
    warnings: [],
    conflicts: [],
  };
  const merged = mergeDocumentLane(baseline, documents, 5, 5);
  assert.deepEqual(merged.results.map((r) => r.text), ["same text", "loc", "fresh doc"]);
  assert.equal(mergeDocumentLane(baseline, documents, 2, 5).results.length, 2);
});

test("mergeDocumentLane never evicts baseline documents that count towards the reservation", () => {
  const ids = (merged) => merged.results.map((r) => r.id);
  const lane = (...list) => ({ results: list.map((id) => item(id, "document")), warnings: [], conflicts: [] });
  // Low-ranked baseline document at the final position: it stays, one lane document joins it.
  const last = { results: [item("m1"), item("m2"), item("m3"), item("m4"), item("d1", "document")], warnings: [], conflicts: [] };
  assert.deepEqual(ids(mergeDocumentLane(last, lane("d1", "d2", "d3"), 5, 2)), ["m1", "m2", "m3", "d1", "d2"]);
  // Interleaved baseline documents: both retained, relative order preserved, no lane document needed.
  const interleaved = {
    results: [item("m1"), item("d1", "document"), item("m2"), item("d2", "document"), item("m3")],
    warnings: [],
    conflicts: [],
  };
  assert.deepEqual(ids(mergeDocumentLane(interleaved, lane("d3", "d4"), 5, 2)), ["m1", "d1", "m2", "d2", "m3"]);
  assert.deepEqual(ids(mergeDocumentLane(interleaved, lane("d3", "d4"), 5, 3)), ["m1", "d1", "m2", "d2", "d3"]);
  // Guarantee is bounded by maxResults and by available distinct documents.
  const documentsOnly = mergeDocumentLane(last, lane("d1"), 5, 4);
  assert.equal(documentsOnly.results.filter((r) => r.source === "document").length, 1);
  assert.deepEqual(ids(mergeDocumentLane(last, lane("d2", "d3"), 2, 5)), ["d1", "d2"]);
  // A baseline longer than maxResults still keeps the reserved document beyond the prefix.
  assert.deepEqual(ids(mergeDocumentLane(last, lane("d2"), 3, 1)), ["m1", "m2", "d1"]);
});

test("mergeDocumentLane protects matching baseline entries from eviction", () => {
  const ids = (merged) => merged.results.map((r) => r.id);
  const lane = (...list) => ({ results: list.map((id) => item(id, "document")), warnings: [], conflicts: [] });
  const base = { results: [item("m1"), item("m2"), item("m3"), item("m4"), item("e1")], warnings: [], conflicts: [] };
  const isEvidence = (entry) => entry.id === "e1";
  assert.deepEqual(ids(mergeDocumentLane(base, lane("d1", "d2", "d3"), 5, 2)), ["m1", "m2", "m3", "d1", "d2"]);
  assert.deepEqual(ids(mergeDocumentLane(base, lane("d1", "d2", "d3"), 5, 2, isEvidence)), ["m1", "m2", "e1", "d1", "d2"]);
  // Protected evidence outranks lane documents when both cannot fit, but not baseline documents.
  assert.deepEqual(ids(mergeDocumentLane(base, lane("d1", "d2"), 2, 2, isEvidence)), ["e1", "d1"]);
  const withDocument = { results: [item("d0", "document"), item("e1")], warnings: [], conflicts: [] };
  assert.deepEqual(ids(mergeDocumentLane(withDocument, lane("d1"), 1, 1, () => true)), ["d0"]);
  // A baseline document repeated under the same id is reserved once.
  const twice = { results: [item("d0", "document"), item("m1"), item("d0", "document"), item("m2")], warnings: [], conflicts: [] };
  assert.equal(mergeDocumentLane(twice, lane("d1"), 4, 2).results.filter((r) => r.source === "document" && r.id !== undefined).length >= 2, true);
  assert.ok(ids(mergeDocumentLane(twice, lane("d1"), 4, 2)).includes("d1"));
});

test("mergeDocumentLane counts a document repeated inside the lane once", () => {
  const base = { results: ["a", "b", "c", "d", "e"].map((id) => item(id)), warnings: [], conflicts: [] };
  const lane = {
    results: [
      item("d2", "document"),
      item("d2", "document"),
      { text: "loc", source: "document", path: "x.md", line: 4 },
      { text: "loc again", source: "document", path: "x.md", line: 4 },
      { text: "same", source: "document" },
      { text: "same", source: "document" },
    ],
    warnings: [],
    conflicts: [],
  };
  const merged = mergeDocumentLane(base, lane, 5, 3);
  assert.deepEqual(merged.results.map((r) => r.id ?? r.text), ["a", "b", "d2", "loc", "same"]);
  assert.deepEqual(
    mergeDocumentLane(base, { results: [item("d2", "document"), item("d2", "document"), item("d3", "document")], warnings: [], conflicts: [] }, 5, 2)
      .results.map((r) => r.id),
    ["a", "b", "c", "d2", "d3"],
  );
});

test("mergeDocumentLane merges coverage and warnings and handles low confidence", () => {
  const baseline = {
    results: [item("a")],
    warnings: ["w1"],
    conflicts: [],
    coverage: { main: "searched", archive: "searched", documents: "searched" },
    lowConfidence: true,
  };
  const withFresh = { results: [item("x", "document")], warnings: ["w2"], conflicts: [], coverage: { documents: "searched" } };
  const merged = mergeDocumentLane(baseline, withFresh, 5, 2);
  assert.deepEqual(merged.warnings, ["w1", "w2"]);
  assert.equal(merged.lowConfidence, undefined, "stronger documents evidence clears low confidence");
  assert.ok(merged.coverage);

  const bothLow = mergeDocumentLane(baseline, { ...withFresh, lowConfidence: true }, 5, 2);
  assert.equal(bothLow.lowConfidence, true);

  const nothingAdded = mergeDocumentLane(baseline, { results: [], warnings: [], conflicts: [] }, 5, 2);
  assert.equal(nothingAdded.lowConfidence, true, "an empty documents lane keeps the baseline flag");
  assert.deepEqual(nothingAdded.results.map((r) => r.id), ["a"]);

  const unflagged = mergeDocumentLane({ ...baseline, lowConfidence: undefined }, withFresh, 5, 2);
  assert.equal(unflagged.lowConfidence, undefined);
});
