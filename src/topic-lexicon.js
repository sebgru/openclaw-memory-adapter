/**
 * Default, generic topic lexicon (German, English, Russian). No personal data:
 * entity aliases such as family-member names come from plugin configuration.
 *
 * Term syntax (matching is case-, diacritic- and umlaut-digraph-insensitive;
 * see `foldText` in topic-trigger.js):
 *   word      whole word only
 *   word*     word prefix, covers inflections ("kind*" -> kinder, kindern)
 *   *word     word suffix, covers German compounds ("*schule" -> grundschule)
 *   *word*    infix, ("*versicherung*" -> autoversicherung, versicherungen)
 *   a b       phrase; whitespace in the text matches any whitespace run
 * Terms are deliberately specific: ambiguous everyday words ("work", "home",
 * "job", "address", "analysis") are left out so ordinary technical turns do not
 * trigger a documents lookup.
 */
export const DEFAULT_LEXICON = {
  family: [
    // en
    "my wife", "my husband", "my son", "my daughter", "our son", "our daughter",
    "my kids", "our kids", "my children", "our children", "my child", "our child", "kids",
    "wife", "husband", "spouse", "parents", "mother", "father", "mom", "dad",
    "brother", "sister", "sibling*", "grandma", "grandpa", "grandmother", "grandfather",
    "my family", "our family", "family member*", "family situation", "birth certificate", "custody", "nephew", "niece",
    // de
    "meine frau", "mein mann", "ehefrau", "ehemann", "ehepartner", "sohn*", "tochter",
    "mein kind", "unser kind", "das kind", "dem kind", "ein kind", "kinder", "kindern", "kindes*", "kindergeld", "eltern", "mutter", "vater",
    "mama", "papa", "bruder", "schwester", "geschwister", "oma", "opa", "grosseltern",
    "enkel*", "familie*", "verwandt*", "geburtsurkunde*", "sorgerecht*", "heirat*", "hochzeit*",
    "lebensgefahrte*", "lebensgefahrtin*",
    // ru
    "жена", "жены", "жене", "жену", "женой", "муж", "мужа", "мужу", "мужем", "муже",
    "сын*", "дочь", "дочери", "дочка", "дочку", "дочкой", "дочерью", "дочки",
    "ребенок", "ребенка", "ребенку", "ребенком", "ребенке", "дети", "детей", "детям", "детьми", "детях",
    "семья", "семьи", "семье", "семью", "семьей", "семейн*",
    "мама", "маму", "мамы", "маме", "мамой", "папа", "папу", "папы", "папе", "папой",
    "родител*", "мать", "матери", "отец", "отца", "отцу", "отцом",
    "брат", "брата", "брату", "братом", "брате", "братья", "сестра", "сестры", "сестре", "сестру", "сестрой",
    "бабушк*", "дедушк*", "свидетельство о рождении",
  ],
  home: [
    // en
    "my address", "our address", "home address", "street address", "new address", "old address",
    "residence", "residency", "apartment", "landlord", "rent", "rental",
    "mortgage", "housing", "my house", "our house", "new house", "condo", "real estate",
    "homeowner*", "where do we live", "where i live", "we live",
    // de
    "wohn*", "wohnort", "wohnsitz", "wohnadresse", "meldeadresse", "anschrift", "unsere adresse",
    "meine adresse", "neue adresse", "alte adresse", "haus", "hauses", "hauskauf", "hausbau",
    "eigenheim", "miete*", "vermieter*", "mieter*", "hausverwaltung", "nebenkosten", "mietvertrag*",
    "eigentum*", "immobilie*", "grundstuck*", "grundbuch*", "hypothek*", "baufinanzierung",
    "umzug", "umziehen",
    // ru
    "наш адрес", "мой адрес", "домашний адрес", "адрес проживания", "новый адрес", "старый адрес",
    "квартир*", "аренд*", "арендодател*", "жилье", "жилья", "жильем", "жилой", "жилищн*",
    "ипотек*", "прописк*", "место жительства", "места жительства", "где мы живем",
    "проживани*", "коммунальн*", "недвижимост*", "переезд*", "домовладел*", "наш дом", "нашем доме",
  ],
  vehicle: [
    // en
    "car", "cars", "vehicle*", "license plate", "number plate", "registration plate", "tuv",
    "driver's license", "drivers license", "driving licen*", "tire", "tires", "tyre", "tyres",
    "oil change", "odometer", "mileage", "dealership",
    // de
    "mein auto", "unser auto", "unser neues auto", "mein neues auto", "das auto", "dem auto",
    "ein auto", "neues auto", "autos", "autohaus", "autokauf", "autoreifen", "fahrzeug*", "pkw", "kfz", "wagen",
    "kennzeichen", "nummernschild*", "fuhrerschein*", "hauptuntersuchung", "zulassung*",
    "zulassungsbescheinigung", "fahrzeugschein", "fahrzeugbrief", "reifen", "olwechsel",
    "kilometerstand", "leasingvertrag*", "werkstatt", "inspektion", "motorrad*",
    // ru
    "машина", "машины", "машине", "машину", "машиной", "авто", "автомобил*", "госномер",
    "номерной знак", "номерного знака", "водительск*", "техосмотр", "шины", "замена масла",
    "пробег*", "автосервис", "лизинг*",
  ],
  finance: [
    // en
    "bank", "banks", "banking", "bank account", "account balance", "iban", "credit card",
    "debit card", "credit score", "credit rating", "credit report", "loan", "loans", "savings",
    "brokerage", "tax", "taxes", "taxable", "tax return", "invoice*", "pension*", "retirement",
    "investment*", "overdraft", "interest rate", "standing order", "direct debit",
    // de
    "banken", "bankkonto", "bankverbindung", "bankkarte", "konto*", "*konto", "konten", "*konten", "kredit*",
    "darlehen*", "sparkonto", "sparkasse*", "depot", "aktien*", "steuer", "steuerbescheid*", "steuererklarung*", "steuerberater*", "steuernummer",
    "steuerklasse*", "steueridentifikationsnummer", "finanz*", "rente",
    "renten*", "uberweisung*", "lastschrift*", "dauerauftrag", "rechnung*", "schufa",
    // ru
    "банк*", "счет", "счета", "счету", "счетом", "счете", "кредит*", "вклад*", "депозит*",
    "налог*", "налоговая", "пенси*", "сбережени*", "инвестици*", "брокер*", "задолженност*",
  ],
  insurance: [
    // en
    "insur*", "policyholder", "policy number", "deductible",
    // de
    "*versicherung*", "versicher*", "policen", "haftpflicht*", "hausrat*",
    "rechtsschutz*", "krankenkasse*", "selbstbeteiligung", "kasko*",
    // ru
    "страховк*", "страхов*", "полис*", "осаго", "каско", "франшиз*", "страховщик*",
  ],
  school: [
    // en
    "school", "schools", "kindergarten", "daycare", "day care", "childcare", "nursery",
    "preschool", "pre-school", "teacher*", "homework", "report card", "parent-teacher",
    "enrol*", "tuition",
    // de
    "schule", "schulen", "*schule", "schuler*", "schulanmeldung", "schulbeginn", "schulzeugnis",
    "schulweg", "schulferien", "schulkind*", "schulplatz", "schulgeld", "kita", "kitas",
    "kindertagesstatte*", "krippe", "tagesmutter", "*lehrer*", "hausaufgaben", "zeugnis*",
    "elternabend", "elternsprechtag", "einschulung", "klassenarbeit*", "unterricht*",
    // ru
    "школ*", "садик*", "детский сад", "детского сада", "детскому саду", "детском саду",
    "детским садом", "детсад*", "учител*", "домашнее задание", "домашние задания", "домашка",
    "одноклассник*", "воспитател*", "гимнази*", "лицей*", "родительское собрание", "аттестат*",
  ],
  work: [
    // en
    "employer", "employers", "employee", "employees", "employment", "my job", "new job",
    "job offer", "job application", "job interview", "salary", "payslip", "pay slip",
    "paycheck", "employment contract", "work contract", "colleague*", "coworker*", "co-worker*",
    "my boss", "human resources", "resign*", "notice period", "severance", "cover letter",
    "curriculum vitae", "wage*", "unemployment",
    // de
    "arbeitgeber*", "arbeitnehmer*", "arbeitsvertrag*", "arbeitsstelle", "arbeitsplatz",
    "arbeitszeit*", "arbeitsamt", "arbeitslos*", "arbeitsagentur", "gehalt", "gehalts*", "gehalter", "gehaltern", "bruttogehalt*", "nettogehalt*", "grundgehalt*", "lohn",
    "lohnabrechnung*", "lohnsteuer*", "lohnzettel", "verdienstbescheinigung*", "kundigung*", "kundigen", "gekundigt",
    "bewerbung*", "vorstellungsgesprach*", "chef", "chefin", "kolleg*", "mein job", "neuer job",
    "jobangebot*", "jobwechsel", "personalabteilung", "betriebsrat", "probezeit", "abfindung*",
    "uberstunden", "dienstreise*", "homeoffice",
    // ru
    "работодател*", "работник*", "зарплат*", "оклад*", "трудовой договор", "трудового договора",
    "увольнени*", "уволи*", "начальник*", "коллег*", "собеседовани*",
    "вакансия", "вакансии", "расчетный листок", "расчетного листка", "босс*", "шеф*",
  ],
  health: [
    // en
    "my doctor", "the doctor", "a doctor", "family doctor", "doctor's appointment",
    "doctor appointment", "doctors", "physician", "hospital", "clinic", "dentist", "dental",
    "medical", "medication*", "medicine", "prescription*", "vaccin*", "allerg*",
    "surgery", "therapist", "therapy", "sick note", "sick leave", "illness",
    "pediatric*", "paediatric*", "blood test", "blood pressure", "x-ray", "pharmacy",
    "pregnan*", "medical record*", "lab results", "checkup", "check-up",
    // de
    "*arzt*", "krank*", "gesundheit*", "medizin*", "medikament*", "verschreibung*",
    "klinik*", "spital", "impf*", "therap*", "zahn*", "apotheke*",
    "blutdruck", "bluttest", "blutwerte", "befund*", "attest", "vorsorge*", "schwanger*",
    "physio*", "orthopad*", "psycholog*",
    // ru
    "врач*", "доктор*", "больниц*", "поликлиник*", "клиник*", "стоматолог*", "зуб*",
    "лекарств*", "прививк*", "аллерги*", "больничн*", "здоровь*",
    "болезн*", "болит", "болеет", "заболевани*", "терапевт*", "педиатр*", "аптек*",
    "медицин*", "беременн*", "лечени*",
  ],
};
