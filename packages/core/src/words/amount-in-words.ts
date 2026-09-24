import { dec, type DecimalInput, roundAmount } from "../money/decimal.js";

/**
 * Amount in words for invoices, using the Indian numbering system
 * (thousand, lakh, crore). English and Hindi are built in; other languages
 * register a `NumberWords` implementation.
 */
export interface NumberWords {
  /** Words for 0..99. */
  belowHundred: readonly string[];
  hundred: string;
  thousand: string;
  lakh: string;
  crore: string;
  format(rupeeWords: string, paiseWords: string | null): string;
}

const EN_ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const EN_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

const EN_BELOW_HUNDRED: string[] = Array.from({ length: 100 }, (_, n) => {
  if (n < 20) return EN_ONES[n]!;
  const t = EN_TENS[Math.floor(n / 10)]!;
  return n % 10 ? `${t} ${EN_ONES[n % 10]}` : t;
});

/** Hindi numbers 0-99 are irregular words, so they are listed explicitly. */
const HI_BELOW_HUNDRED = [
  "शून्य", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ",
  "दस", "ग्यारह", "बारह", "तेरह", "चौदह", "पंद्रह", "सोलह", "सत्रह", "अठारह", "उन्नीस",
  "बीस", "इक्कीस", "बाईस", "तेईस", "चौबीस", "पच्चीस", "छब्बीस", "सत्ताईस", "अट्ठाईस", "उनतीस",
  "तीस", "इकतीस", "बत्तीस", "तैंतीस", "चौंतीस", "पैंतीस", "छत्तीस", "सैंतीस", "अड़तीस", "उनतालीस",
  "चालीस", "इकतालीस", "बयालीस", "तैंतालीस", "चवालीस", "पैंतालीस", "छियालीस", "सैंतालीस", "अड़तालीस", "उनचास",
  "पचास", "इक्यावन", "बावन", "तिरेपन", "चौवन", "पचपन", "छप्पन", "सत्तावन", "अट्ठावन", "उनसठ",
  "साठ", "इकसठ", "बासठ", "तिरेसठ", "चौंसठ", "पैंसठ", "छियासठ", "सड़सठ", "अड़सठ", "उनहत्तर",
  "सत्तर", "इकहत्तर", "बहत्तर", "तिहत्तर", "चौहत्तर", "पचहत्तर", "छिहत्तर", "सतहत्तर", "अठहत्तर", "उन्यासी",
  "अस्सी", "इक्यासी", "बयासी", "तिरासी", "चौरासी", "पचासी", "छियासी", "सत्तासी", "अट्ठासी", "नवासी",
  "नब्बे", "इक्यानबे", "बानबे", "तिरानबे", "चौरानबे", "पचानबे", "छियानबे", "सत्तानबे", "अट्ठानबे", "निन्यानबे",
];

export const NUMBER_WORDS: Record<string, NumberWords> = {
  en: {
    belowHundred: EN_BELOW_HUNDRED,
    hundred: "Hundred",
    thousand: "Thousand",
    lakh: "Lakh",
    crore: "Crore",
    format: (rupees, paise) => `Rupees ${rupees}${paise ? ` and ${paise} Paise` : ""} Only`,
  },
  hi: {
    belowHundred: HI_BELOW_HUNDRED,
    hundred: "सौ",
    thousand: "हज़ार",
    lakh: "लाख",
    crore: "करोड़",
    format: (rupees, paise) => `${rupees} रुपये${paise ? ` और ${paise} पैसे` : ""} मात्र`,
  },
};

export function integerInWords(n: number, words: NumberWords): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Cannot convert ${n} to words`);
  if (n < 100) return words.belowHundred[n]!;
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  let rest = n % 10_000_000;
  if (crore) parts.push(`${integerInWords(crore, words)} ${words.crore}`);
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  if (lakh) parts.push(`${words.belowHundred[lakh]} ${words.lakh}`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand) parts.push(`${words.belowHundred[thousand]} ${words.thousand}`);
  const hundred = Math.floor(rest / 100);
  rest %= 100;
  if (hundred) parts.push(`${words.belowHundred[hundred]} ${words.hundred}`);
  if (rest) parts.push(words.belowHundred[rest]!);
  return parts.join(" ");
}

export function amountInWords(amount: DecimalInput, locale = "en"): string {
  const words = NUMBER_WORDS[locale] ?? NUMBER_WORDS.en!;
  const value = roundAmount(dec(amount).abs());
  const rupees = value.floor().toNumber();
  const paise = value.minus(value.floor()).times(100).toNumber();
  const text = words.format(integerInWords(rupees, words), paise ? integerInWords(paise, words) : null);
  return dec(amount).isNegative() ? `(-) ${text}` : text;
}
