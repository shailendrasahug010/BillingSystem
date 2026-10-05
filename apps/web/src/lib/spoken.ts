/**
 * What a person said to add an item: "Parle G 10 box", "Lux soap das peti",
 * "२ डिब्बा तेल". The name to search for, and the quantity and unit word when
 * they were said (at the end, or at the start).
 */
export interface SpokenItem {
  name: string;
  qty: number | null;
  unit: string | null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50, hundred: 100,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10,
  gyarah: 11, barah: 12, pandrah: 15, bees: 20, tees: 30, pachas: 50, sau: 100,
  एक: 1, दो: 2, तीन: 3, चार: 4, पांच: 5, पाँच: 5, छह: 6, छः: 6, सात: 7, आठ: 8, नौ: 9, दस: 10,
  ग्यारह: 11, बारह: 12, पंद्रह: 15, बीस: 20, तीस: 30, पचास: 50, सौ: 100,
};

/** Spoken unit words, by the unit symbols they mean. */
const UNIT_WORDS: Record<string, string[]> = {
  BOX: ["box", "boxes", "dibba", "dibbe", "डिब्बा", "डिब्बे", "बॉक्स", "peti", "petti", "पेटी", "carton", "cartons", "कार्टन"],
  PCS: ["piece", "pieces", "pcs", "pc", "nag", "नग", "पीस"],
  STRIP: ["strip", "strips", "patta", "patte", "पत्ता", "पत्ते", "स्ट्रिप"],
  PKT: ["packet", "packets", "pack", "packs", "pkt", "पैकेट", "पैक"],
  KG: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms", "किलो"],
  LTR: ["litre", "litres", "liter", "liters", "l", "ltr", "लीटर"],
  DOZ: ["dozen", "dozens", "darjan", "दर्जन"],
  BAG: ["bag", "bags", "bori", "बोरी", "थैला"],
  CASE: ["case", "cases", "केस"],
  BTL: ["bottle", "bottles", "botal", "बोतल"],
};
const UNIT_OF = new Map(Object.entries(UNIT_WORDS).flatMap(([symbol, words]) => words.map((w) => [w, symbol] as const)));

const DEVANAGARI = "०१२३४५६७८९";
const toNumber = (word: string): number | null => {
  const w = word.toLowerCase().replace(/[०-९]/g, (d) => String(DEVANAGARI.indexOf(d)));
  if (/^\d+(\.\d+)?$/.test(w)) return Number(w);
  return NUMBER_WORDS[w] ?? null;
};

export function parseSpokenItem(text: string): SpokenItem {
  const words = text.trim().replace(/[,.!?]+/g, " ").split(/\s+/).filter(Boolean);
  let qty: number | null = null;
  let unit: string | null = null;
  // "... 10 box" / "... box 10" at the end; else "10 box ..." at the start.
  const take = (at: number) => {
    const n = toNumber(words[at] ?? "");
    if (n === null || n <= 0) return false;
    qty = n;
    words.splice(at, 1);
    return true;
  };
  const takeUnit = (at: number) => {
    const u = UNIT_OF.get((words[at] ?? "").toLowerCase());
    if (!u) return false;
    unit = u;
    words.splice(at, 1);
    return true;
  };
  if (words.length > 1) {
    const last = words.length - 1;
    if (takeUnit(last)) take(words.length - 1);
    else if (take(last)) takeUnit(words.length - 1);
    if (qty === null && words.length > 1) {
      if (take(0)) takeUnit(0);
    }
  }
  return { name: words.join(" "), qty, unit };
}

/** The unit of the product a spoken unit word names (by symbol, or a symbol it starts with). */
export function unitForWord<T extends { symbol: string }>(units: T[], word: string | null): T | undefined {
  if (!word) return undefined;
  const w = word.toUpperCase();
  return units.find((u) => u.symbol.toUpperCase() === w) ?? units.find((u) => u.symbol.toUpperCase().startsWith(w) || w.startsWith(u.symbol.toUpperCase()));
}
