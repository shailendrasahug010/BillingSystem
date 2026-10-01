import {
  addDays,
  calculateDocument,
  gstinCheckChar,
  NO_TAX,
  resolveTax,
  todayIn,
  type PaymentMethod,
  type TaxCategory,
} from "@digitalbahi/core";
import type { Brand, Business, Customer, DayAmount, Invoice, Order, Payment, Product } from "./types";

/**
 * Deterministic sample data for the prototype: a Bhopal FMCG distributor,
 * 48 products from 19 companies, 24 retailers with real buying habits and
 * six months of invoices whose totals come from the real GST engine.
 * GST rates here are ILLUSTRATIVE sample data; in the product they are
 * maintained as effective-dated tax rules.
 */
export const TODAY = todayIn("Asia/Kolkata");

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260924);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const between = (min: number, max: number) => Math.round(min + rand() * (max - min));

export function makeGstin(stateCode: string, pan: string): string {
  const first14 = `${stateCode}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
}

export const BUSINESS: Business = {
  name: "Shree Ganesh Distributors",
  legalName: "Shree Ganesh Distributors (Prop. Anil Sharma)",
  gstin: makeGstin("23", "ABKPS4521M"),
  stateCode: "23",
  address: "Plot 14, Govindpura Industrial Area",
  city: "Bhopal, Madhya Pradesh 462023",
  phone: "+91 98260 41234",
  email: "accounts@shreeganeshdist.in",
  bank: { name: "State Bank of India, Govindpura", account: "XXXX XXXX 4417", ifsc: "SBIN0004589", upi: "shreeganesh@sbi" },
};

// ---------- Tax categories: rates are data with effective dates ----------
const cat = (id: string, name: string, rules: TaxCategory["rules"], kind: TaxCategory["kind"] = "taxable"): TaxCategory => ({
  id,
  name,
  kind,
  rules,
});
const since2017 = "2017-07-01";
const reform = "2025-09-22";
const before = "2025-09-21";
export const TAX_CATEGORIES = {
  food5: cat("food5", "Packaged food 5%", [{ id: "food5-a", effectiveFrom: since2017, gstRate: 5 }]),
  biscuits: cat("biscuits", "Biscuits & confectionery", [
    { id: "bis-18", effectiveFrom: since2017, effectiveTo: before, gstRate: 18 },
    { id: "bis-5", effectiveFrom: reform, gstRate: 5 },
  ]),
  noodles: cat("noodles", "Noodles & ready foods", [
    { id: "nd-12", effectiveFrom: since2017, effectiveTo: before, gstRate: 12 },
    { id: "nd-5", effectiveFrom: reform, gstRate: 5 },
  ]),
  personal: cat("personal", "Soap, toothpaste, shampoo", [
    { id: "pc-18", effectiveFrom: since2017, effectiveTo: before, gstRate: 18 },
    { id: "pc-5", effectiveFrom: reform, gstRate: 5 },
  ]),
  household18: cat("household18", "Detergents & cleaners", [{ id: "hh-18", effectiveFrom: since2017, gstRate: 18 }]),
  aerated: cat("aerated", "Aerated beverages", [
    { id: "aer-28", effectiveFrom: since2017, effectiveTo: before, gstRate: 28, cessRate: 12 },
    { id: "aer-40", effectiveFrom: reform, gstRate: 40 },
  ]),
  nil: cat("nil", "Nil rated (fresh milk, salt, bread)", [], "nil_rated"),
} as const satisfies Record<string, TaxCategory>;

type TaxKey = keyof typeof TAX_CATEGORIES;

const BRAND_NAMES = [
  "Parle",
  "Britannia",
  "HUL",
  "ITC",
  "Nestlé",
  "Tata Consumer",
  "Amul",
  "Coca-Cola",
  "PepsiCo",
  "Dabur",
  "Colgate-Palmolive",
  "Haldiram's",
  "Fortune",
  "Reckitt",
  "Everest",
  "MDH",
  "Mondelez",
  "Bisleri",
  "Godrej",
];
export const BRANDS: Brand[] = BRAND_NAMES.map((name, i) => ({ id: `b${i + 1}`, name }));
const brandId = (name: string) => BRANDS.find((b) => b.name === name)!.id;

// name, nameHi, brand, category, hsn, tax, unit, pack, case, mrp, rate, aliases
type Row = [string, string, string, string, string, TaxKey, string, string, number, number, number, string[]?];
const PRODUCT_ROWS: Row[] = [
  ["Parle-G Gold 100g", "पारले-जी गोल्ड 100 ग्रा", "Parle", "Biscuits", "1905", "biscuits", "PCS", "100 g", 12, 10, 8.6, ["parleg", "parle g"]],
  ["Parle Monaco 75g", "पारले मोनाको 75 ग्रा", "Parle", "Biscuits", "1905", "biscuits", "PCS", "75 g", 12, 10, 8.5],
  ["Parle Hide & Seek 100g", "पारले हाइड एंड सीक", "Parle", "Biscuits", "1905", "biscuits", "PCS", "100 g", 12, 30, 25.5],
  ["Britannia Good Day Cashew 100g", "ब्रिटानिया गुड डे काजू", "Britannia", "Biscuits", "1905", "biscuits", "PCS", "100 g", 12, 30, 25.8],
  ["Britannia Marie Gold 250g", "ब्रिटानिया मैरी गोल्ड", "Britannia", "Biscuits", "1905", "biscuits", "PCS", "250 g", 12, 40, 34],
  ["Britannia Bread 400g", "ब्रिटानिया ब्रेड 400 ग्रा", "Britannia", "Bakery", "1905", "nil", "PCS", "400 g", 1, 45, 40, ["pav", "ब्रेड"]],
  ["Surf Excel Easy Wash 1kg", "सर्फ़ एक्सेल ईज़ी वॉश 1 किग्रा", "HUL", "Detergent", "3402", "household18", "PCS", "1 kg", 6, 140, 118, ["surf"]],
  ["Rin Detergent Bar 250g", "रिन डिटर्जेंट बार", "HUL", "Detergent", "3401", "household18", "PCS", "250 g", 10, 22, 18.8],
  ["Lifebuoy Soap 100g", "लाइफ़बॉय साबुन 100 ग्रा", "HUL", "Personal care", "3401", "personal", "PCS", "100 g", 12, 38, 33, ["sabun", "साबुन"]],
  ["Vim Dishwash Bar 300g", "विम बार 300 ग्रा", "HUL", "Household", "3405", "household18", "PCS", "300 g", 12, 30, 26],
  ["Clinic Plus Shampoo Sachet (16)", "क्लिनिक प्लस शैम्पू सैशे", "HUL", "Personal care", "3305", "personal", "STRIP", "16 x 6 ml", 10, 32, 28],
  ["Brooke Bond Red Label Tea 250g", "रेड लेबल चाय 250 ग्रा", "HUL", "Tea & coffee", "0902", "food5", "PCS", "250 g", 12, 145, 128, ["chai", "चाय"]],
  ["Kissan Tomato Ketchup 500g", "किसान टोमैटो केचप", "HUL", "Sauces", "2103", "food5", "PCS", "500 g", 12, 130, 112],
  ["Horlicks Classic Malt 500g", "हॉर्लिक्स 500 ग्रा", "HUL", "Health drinks", "1901", "food5", "PCS", "500 g", 6, 285, 255],
  ["Aashirvaad Atta 5kg", "आशीर्वाद आटा 5 किग्रा", "ITC", "Staples", "1101", "food5", "BAG", "5 kg", 4, 285, 262, ["atta", "आटा"]],
  ["Sunfeast Dark Fantasy 75g", "सनफ़ीस्ट डार्क फ़ैंटेसी", "ITC", "Biscuits", "1905", "biscuits", "PCS", "75 g", 12, 40, 34.5],
  ["Bingo Mad Angles 66g", "बिंगो मैड एंगल्स", "ITC", "Snacks", "2106", "food5", "PCS", "66 g", 24, 20, 17.2],
  ["Yippee Noodles 4-pack", "यिप्पी नूडल्स 4 पैक", "ITC", "Noodles", "1902", "noodles", "PCS", "4 x 70 g", 12, 60, 52],
  ["Maggi 2-Minute Noodles 70g", "मैगी नूडल्स 70 ग्रा", "Nestlé", "Noodles", "1902", "noodles", "PCS", "70 g", 24, 14, 12.2, ["maggie"]],
  ["Nescafé Classic 50g", "नेस्कैफ़े क्लासिक 50 ग्रा", "Nestlé", "Tea & coffee", "2101", "food5", "PCS", "50 g", 12, 185, 162, ["coffee", "कॉफ़ी"]],
  ["KitKat 4 Finger", "किटकैट 4 फ़िंगर", "Nestlé", "Chocolates", "1806", "biscuits", "PCS", "37.3 g", 24, 30, 25.8],
  ["Tata Salt 1kg", "टाटा नमक 1 किग्रा", "Tata Consumer", "Staples", "2501", "nil", "PCS", "1 kg", 10, 30, 26.5, ["namak", "नमक"]],
  ["Tata Tea Premium 250g", "टाटा टी प्रीमियम 250 ग्रा", "Tata Consumer", "Tea & coffee", "0902", "food5", "PCS", "250 g", 12, 150, 131, ["chai", "चाय"]],
  ["Tata Sampann Toor Dal 1kg", "टाटा संपन्न तूर दाल", "Tata Consumer", "Staples", "0713", "food5", "PCS", "1 kg", 10, 190, 172, ["dal", "दाल"]],
  ["Amul Butter 100g", "अमूल बटर 100 ग्रा", "Amul", "Dairy", "0405", "food5", "PCS", "100 g", 10, 58, 53, ["makhan", "मक्खन"]],
  ["Amul Taaza Milk 1L", "अमूल ताज़ा दूध 1 ली", "Amul", "Dairy", "0401", "nil", "PCS", "1 L", 12, 68, 64, ["doodh", "दूध", "milk"]],
  ["Amul Cheese Slices 200g", "अमूल चीज़ स्लाइस", "Amul", "Dairy", "0406", "food5", "PCS", "200 g", 10, 145, 131],
  ["Coca-Cola 750ml", "कोका-कोला 750 मिली", "Coca-Cola", "Beverages", "2202", "aerated", "BTL", "750 ml", 12, 40, 30, ["coke", "cold drink"]],
  ["Thums Up 750ml", "थम्स अप 750 मिली", "Coca-Cola", "Beverages", "2202", "aerated", "BTL", "750 ml", 12, 40, 30, ["thumbs up", "cold drink"]],
  ["Kinley Water 1L", "किनले पानी 1 ली", "Coca-Cola", "Beverages", "2201", "food5", "BTL", "1 L", 12, 20, 15, ["pani", "पानी"]],
  ["Lay's Classic Salted 52g", "लेज़ क्लासिक 52 ग्रा", "PepsiCo", "Snacks", "2005", "food5", "PCS", "52 g", 24, 20, 17.2, ["chips"]],
  ["Kurkure Masala Munch 90g", "कुरकुरे मसाला मंच", "PepsiCo", "Snacks", "2106", "food5", "PCS", "90 g", 24, 20, 17.2],
  ["Dabur Red Toothpaste 200g", "डाबर रेड टूथपेस्ट", "Dabur", "Personal care", "3306", "personal", "PCS", "200 g", 12, 125, 108],
  ["Dabur Honey 250g", "डाबर शहद 250 ग्रा", "Dabur", "Staples", "0409", "food5", "PCS", "250 g", 12, 135, 118, ["shahad", "शहद"]],
  ["Real Mixed Fruit Juice 1L", "रियल मिक्स फ्रूट जूस", "Dabur", "Beverages", "2009", "food5", "PCS", "1 L", 12, 125, 108],
  ["Colgate Strong Teeth 200g", "कोलगेट स्ट्रॉन्ग टीथ", "Colgate-Palmolive", "Personal care", "3306", "personal", "PCS", "200 g", 12, 118, 101],
  ["Colgate ZigZag Toothbrush", "कोलगेट ज़िगज़ैग ब्रश", "Colgate-Palmolive", "Personal care", "9603", "personal", "PCS", "1 pc", 12, 40, 33],
  ["Haldiram's Aloo Bhujia 200g", "हल्दीराम आलू भुजिया", "Haldiram's", "Snacks", "2106", "food5", "PCS", "200 g", 12, 60, 51, ["namkeen", "नमकीन"]],
  ["Haldiram's Soan Papdi 250g", "हल्दीराम सोन पापड़ी", "Haldiram's", "Sweets", "1704", "food5", "PCS", "250 g", 12, 90, 78],
  ["Fortune Soya Oil 1L Pouch", "फ़ॉर्च्यून सोया तेल 1 ली", "Fortune", "Staples", "1507", "food5", "PCS", "1 L", 10, 155, 142, ["tel", "तेल", "oil"]],
  ["Fortune Chakki Atta 5kg", "फ़ॉर्च्यून चक्की आटा 5 किग्रा", "Fortune", "Staples", "1101", "food5", "BAG", "5 kg", 4, 270, 249, ["atta", "आटा"]],
  ["Dettol Soap 75g", "डेटॉल साबुन 75 ग्रा", "Reckitt", "Personal care", "3401", "personal", "PCS", "75 g", 12, 45, 39, ["sabun", "साबुन"]],
  ["Harpic Power Plus 500ml", "हार्पिक 500 मिली", "Reckitt", "Household", "3402", "household18", "BTL", "500 ml", 12, 110, 94],
  ["Everest Garam Masala 100g", "एवरेस्ट गरम मसाला", "Everest", "Spices", "0910", "food5", "PCS", "100 g", 10, 88, 76, ["masala", "मसाला"]],
  ["MDH Chana Masala 100g", "एमडीएच चना मसाला", "MDH", "Spices", "0910", "food5", "PCS", "100 g", 10, 82, 71, ["masala", "मसाला"]],
  ["Cadbury Dairy Milk 23g", "कैडबरी डेयरी मिल्क", "Mondelez", "Chocolates", "1806", "biscuits", "PCS", "23 g", 24, 20, 17],
  ["Bisleri Water 1L", "बिसलेरी पानी 1 ली", "Bisleri", "Beverages", "2201", "food5", "BTL", "1 L", 12, 20, 14.5, ["pani", "पानी"]],
  ["Good Knight Gold Flash Refill", "गुड नाइट रिफ़िल", "Godrej", "Household", "3808", "household18", "PCS", "45 ml", 12, 99, 85],
];

const UQC: Record<string, string> = { PCS: "PCS", BTL: "BTL", BAG: "BAG", STRIP: "PAC" };

export const PRODUCTS: Product[] = PRODUCT_ROWS.map((r, i) => {
  const [name, nameHi, brand, category, hsn, taxKey, unit, packSize, caseSize, mrp, rate, aliases] = r;
  const taxCategory = TAX_CATEGORIES[taxKey];
  const gstRate = taxCategory.kind === "taxable" ? resolveTax(taxCategory, { date: TODAY }).gstRate.toNumber() : 0;
  const minStock = caseSize * between(3, 8);
  const roll = rand();
  const stock = roll < 0.06 ? 0 : roll < 0.2 ? Math.max(1, Math.round(minStock * (0.3 + rand() * 0.5))) : minStock * between(2, 9);
  const code = `${brand.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}${String(i + 1).padStart(3, "0")}`;
  const perishable = ["Dairy", "Bakery"].includes(category);
  return {
    id: `p${i + 1}`,
    name,
    nameHi,
    code,
    barcode: `890${String(1000000000 + i * 7919).slice(0, 10)}`,
    brandId: brandId(brand),
    brand,
    category,
    hsn,
    taxCategory,
    gstRate,
    unit,
    uqc: UQC[unit] ?? "NOS",
    packSize,
    caseSize,
    mrp,
    rate,
    wholesaleRate: Math.round(rate * 0.97 * 100) / 100,
    purchasePrice: Math.round(rate * 0.92 * 100) / 100,
    stock,
    minStock,
    aliases: aliases ?? [],
    ...(perishable ? { batch: { number: `B${between(2400, 2499)}`, expiry: addDays(TODAY, between(3, 20)) } } : {}),
  };
});

export const productById = new Map(PRODUCTS.map((p) => [p.id, p]));
const pid = (namePrefix: string) => PRODUCTS.find((p) => p.name.startsWith(namePrefix))!.id;

// ---------- Customers and their habits ----------
export const SALES_REPS = ["Rakesh Yadav", "Imran Khan", "Sunita Patel", "Deepak Soni"];
export const ROUTES = ["Mon · Kolar Road", "Tue · Arera Colony", "Wed · MP Nagar", "Thu · Sehore–Vidisha", "Fri · Old City", "Sat · Hoshangabad Road"];

interface Habit {
  product: string;
  qty: number;
  /** Buy on every n-th visit. */
  every: number;
  /** Stopped buying this many days ago (lapsed habit). */
  stoppedDaysAgo?: number;
}
interface Profile {
  name: string;
  businessName: string;
  city: string;
  area: string;
  stateCode: string;
  pincode: string;
  gstPan: string | null;
  category: string;
  interval: number;
  lastVisitDaysAgo: number;
  creditLimit: number | null;
  creditDays: number;
  /** 0 = pays on time, 1 = always late. */
  lateness: number;
  habits: Habit[];
}

const P = (product: string, qty: number, every = 1, stoppedDaysAgo?: number): Habit => ({ product, qty, every, ...(stoppedDaysAgo ? { stoppedDaysAgo } : {}) });

const PROFILES: Profile[] = [
  {
    name: "Ramesh Agrawal", businessName: "ABC General Store", city: "Bhopal", area: "Kolar Road", stateCode: "23", pincode: "462042",
    gstPan: "AAKFA1234R", category: "Kirana", interval: 7, lastVisitDaysAgo: 6, creditLimit: 50000, creditDays: 15, lateness: 0.25,
    habits: [P("Amul Taaza", 24), P("Parle-G", 20, 2), P("Tata Salt", 15, 2), P("Surf Excel", 10, 3), P("Coca-Cola", 12, 1, 27), P("Maggi", 24, 2), P("Britannia Bread", 10), P("Amul Butter", 10, 2)],
  },
  {
    name: "Suresh Choudhary", businessName: "Shree Balaji Kirana", city: "Bhopal", area: "Kolar Road", stateCode: "23", pincode: "462042",
    gstPan: "BCDPC5521K", category: "Kirana", interval: 7, lastVisitDaysAgo: 8, creditLimit: 40000, creditDays: 15, lateness: 0.5,
    habits: [P("Aashirvaad", 8, 2), P("Tata Salt", 20), P("Fortune Soya", 12), P("Parle-G", 24), P("Rin", 20, 2), P("Tata Tea", 12, 2), P("MDH", 10, 3)],
  },
  {
    name: "Mukesh Gupta", businessName: "Gupta Provision Store", city: "Bhopal", area: "MP Nagar", stateCode: "23", pincode: "462011",
    gstPan: "CEGPG7812L", category: "Kirana", interval: 10, lastVisitDaysAgo: 4, creditLimit: 60000, creditDays: 21, lateness: 0.1,
    habits: [P("Brooke Bond", 12), P("Nescafé", 6, 2), P("Britannia Good Day", 24), P("Britannia Marie", 12), P("Colgate Strong", 12, 2), P("Lifebuoy", 24), P("Dettol", 12, 2)],
  },
  {
    name: "Rajendra Tiwari", businessName: "Maa Durga Traders", city: "Sehore", area: "Station Road", stateCode: "23", pincode: "466001",
    gstPan: "DFTPT3345B", category: "Wholesaler", interval: 14, lastVisitDaysAgo: 18, creditLimit: 150000, creditDays: 30, lateness: 0.7,
    habits: [P("Aashirvaad", 40), P("Fortune Chakki", 30), P("Tata Salt", 100), P("Fortune Soya", 60), P("Parle-G", 144), P("Surf Excel", 36, 2), P("Rin", 100)],
  },
  {
    name: "Nitin Jain", businessName: "Jain Super Mart", city: "Bhopal", area: "Arera Colony", stateCode: "23", pincode: "462016",
    gstPan: "EJNPJ9087C", category: "Modern Trade", interval: 7, lastVisitDaysAgo: 5, creditLimit: 120000, creditDays: 21, lateness: 0.05,
    habits: [P("Amul Cheese", 20), P("Amul Butter", 30), P("Kissan", 12), P("Nescafé", 12, 2), P("Horlicks", 6, 2), P("Real Mixed", 24), P("Lay's", 48), P("Kurkure", 48), P("Cadbury", 48), P("KitKat", 24), P("Britannia Bread", 20)],
  },
  {
    name: "Pradeep Soni", businessName: "New Sai Medical & General", city: "Vidisha", area: "Sanchi Road", stateCode: "23", pincode: "464001",
    gstPan: "FSNPS2231D", category: "Medical", interval: 14, lastVisitDaysAgo: 12, creditLimit: 30000, creditDays: 15, lateness: 0.3,
    habits: [P("Dettol", 24), P("Colgate Strong", 12), P("Colgate ZigZag", 24), P("Dabur Red", 12), P("Dabur Honey", 6, 2), P("Horlicks", 6)],
  },
  {
    name: "Harish Patel", businessName: "Patel Kirana Bhandar", city: "Raisen", area: "Gandhi Chowk", stateCode: "23", pincode: "464551",
    gstPan: "GPTPP6612E", category: "Kirana", interval: 10, lastVisitDaysAgo: 9, creditLimit: 35000, creditDays: 15, lateness: 0.6,
    habits: [P("Tata Salt", 20), P("Parle-G", 48), P("Maggi", 48), P("Vim", 24), P("Rin", 20), P("Clinic Plus", 10, 2), P("Everest", 10, 2)],
  },
  {
    name: "Shivam Rathore", businessName: "Hotel Shivam Palace", city: "Bhopal", area: "Hamidia Road", stateCode: "23", pincode: "462001",
    gstPan: "HRTFR1109F", category: "HoReCa", interval: 5, lastVisitDaysAgo: 4, creditLimit: 80000, creditDays: 30, lateness: 0.4,
    habits: [P("Amul Taaza", 60), P("Amul Butter", 20), P("Tata Tea", 12), P("Kinley", 48), P("Bisleri", 48, 2), P("Kissan", 6, 2), P("Fortune Soya", 20, 2)],
  },
  {
    name: "Omprakash Sahu", businessName: "Om Sai Departmental Store", city: "Bhopal", area: "Kolar Road", stateCode: "23", pincode: "462042",
    gstPan: "JSHPS4471G", category: "Kirana", interval: 7, lastVisitDaysAgo: 7, creditLimit: 45000, creditDays: 15, lateness: 0.2,
    habits: [P("Britannia Bread", 12), P("Amul Butter", 12), P("Maggi", 24, 2), P("Kissan", 6, 2), P("Parle Monaco", 24), P("Thums Up", 12), P("Coca-Cola", 12, 2)],
  },
  {
    name: "Vikas Sharma", businessName: "Sharma Wholesale Traders", city: "Jhansi", area: "Sipri Bazar", stateCode: "09", pincode: "284003",
    gstPan: "KSWFS8820H", category: "Wholesaler", interval: 21, lastVisitDaysAgo: 16, creditLimit: 200000, creditDays: 30, lateness: 0.5,
    habits: [P("Parle-G", 288), P("Parle Monaco", 144), P("Sunfeast", 96), P("Maggi", 240), P("Yippee", 60), P("Bingo", 96)],
  },
  {
    name: "Anil Verma", businessName: "Verma General Store", city: "Bhopal", area: "Old City", stateCode: "23", pincode: "462001",
    gstPan: null, category: "Kirana", interval: 7, lastVisitDaysAgo: 3, creditLimit: 15000, creditDays: 7, lateness: 0.3,
    habits: [P("Parle-G", 12), P("Maggi", 12), P("Tata Salt", 5), P("Lifebuoy", 6), P("Cadbury", 24, 2)],
  },
  {
    name: "Sanjay Khandelwal", businessName: "Khandelwal Stores", city: "Itarsi", area: "Main Market", stateCode: "23", pincode: "461111",
    gstPan: "LKHPK5503J", category: "Kirana", interval: 14, lastVisitDaysAgo: 26, creditLimit: 50000, creditDays: 21, lateness: 0.85,
    habits: [P("Aashirvaad", 10), P("Fortune Chakki", 10), P("Tata Sampann", 20), P("Surf Excel", 12), P("Harpic", 12)],
  },
  {
    name: "Meena Joshi", businessName: "Annapurna Bhojnalaya", city: "Bhopal", area: "MP Nagar", stateCode: "23", pincode: "462011",
    gstPan: null, category: "HoReCa", interval: 4, lastVisitDaysAgo: 2, creditLimit: 20000, creditDays: 7, lateness: 0.2,
    habits: [P("Amul Taaza", 30), P("Tata Sampann", 5), P("Fortune Soya", 10), P("Everest", 4, 2), P("MDH", 4, 2), P("Aashirvaad", 4, 2)],
  },
  {
    name: "Dharmendra Rajput", businessName: "Rajput Kirana", city: "Narmadapuram", area: "Sadar Bazar", stateCode: "23", pincode: "461001",
    gstPan: "MRJPR7788K", category: "Kirana", interval: 10, lastVisitDaysAgo: 11, creditLimit: 30000, creditDays: 15, lateness: 0.4,
    habits: [P("Parle-G", 36), P("Rin", 20), P("Tata Salt", 20), P("Good Knight", 12, 2), P("Haldiram's Aloo", 12)],
  },
  {
    name: "Ritika Malhotra", businessName: "City Mart", city: "Bhopal", area: "Arera Colony", stateCode: "23", pincode: "462016",
    gstPan: "NCTFM2290L", category: "Modern Trade", interval: 7, lastVisitDaysAgo: 0, creditLimit: 100000, creditDays: 21, lateness: 0.1,
    habits: [P("Haldiram's Soan", 24), P("Haldiram's Aloo", 24), P("Real Mixed", 24), P("Nescafé", 12), P("KitKat", 48), P("Cadbury", 96), P("Dabur Honey", 12, 2)],
  },
  {
    name: "Rohit Mehta", businessName: "Mehta Brothers", city: "Indore", area: "Siyaganj", stateCode: "23", pincode: "452007",
    gstPan: "PMHFM3316M", category: "Wholesaler", interval: 21, lastVisitDaysAgo: 20, creditLimit: 250000, creditDays: 30, lateness: 0.3,
    habits: [P("Surf Excel", 72), P("Rin", 200), P("Vim", 144), P("Harpic", 48), P("Lifebuoy", 144)],
  },
  {
    name: "Kiran Deshmukh", businessName: "Sunrise Supermarket", city: "Nagpur", area: "Dharampeth", stateCode: "27", pincode: "440010",
    gstPan: "QSNFD6690N", category: "Modern Trade", interval: 14, lastVisitDaysAgo: 13, creditLimit: 150000, creditDays: 30, lateness: 0.2,
    habits: [P("Horlicks", 24), P("Nescafé", 24), P("Tata Tea", 36), P("Brooke Bond", 36), P("Kissan", 24)],
  },
  {
    name: "Lalit Agrawal", businessName: "Laxmi Traders", city: "Bhopal", area: "Old City", stateCode: "23", pincode: "462001",
    gstPan: "RLXPA1276P", category: "Wholesaler", interval: 10, lastVisitDaysAgo: 30, creditLimit: 100000, creditDays: 30, lateness: 0.9,
    habits: [P("Tata Salt", 60), P("Fortune Soya", 40), P("Aashirvaad", 20), P("Tata Sampann", 30)],
  },
  {
    name: "Kamal Kumar", businessName: "Kumar Pan & General", city: "Bhopal", area: "MP Nagar", stateCode: "23", pincode: "462011",
    gstPan: null, category: "Paan shop", interval: 3, lastVisitDaysAgo: 0, creditLimit: 5000, creditDays: 7, lateness: 0.1,
    habits: [P("Cadbury", 24), P("Lay's", 12), P("Kurkure", 12), P("Thums Up", 6), P("Bisleri", 12)],
  },
  {
    name: "Priya Saxena", businessName: "Fresh Choice Retail", city: "Bhopal", area: "Hoshangabad Road", stateCode: "23", pincode: "462026",
    gstPan: "SFCFS9942Q", category: "Modern Trade", interval: 7, lastVisitDaysAgo: 6, creditLimit: 90000, creditDays: 21, lateness: 0.15,
    habits: [P("Britannia Bread", 30), P("Amul Butter", 30), P("Amul Cheese", 12), P("Real Mixed", 12), P("Kissan", 12, 2), P("Maggi", 48)],
  },
  {
    name: "Ashok Raghuvanshi", businessName: "Anand Provision", city: "Vidisha", area: "Madhavganj", stateCode: "23", pincode: "464001",
    gstPan: "TANPR4458R", category: "Kirana", interval: 10, lastVisitDaysAgo: 10, creditLimit: 40000, creditDays: 15, lateness: 0.5,
    habits: [P("Parle-G", 48), P("Tata Tea", 12), P("Tata Salt", 20), P("Surf Excel", 12), P("Maggi", 48)],
  },
  {
    name: "Gopal Yadav", businessName: "Yadav Dairy & Kirana", city: "Bhopal", area: "Kolar Road", stateCode: "23", pincode: "462042",
    gstPan: null, category: "Dairy", interval: 3, lastVisitDaysAgo: 0, creditLimit: 25000, creditDays: 7, lateness: 0.3,
    habits: [P("Amul Taaza", 48), P("Amul Butter", 10, 2), P("Britannia Bread", 10)],
  },
  {
    name: "Vinod Mishra", businessName: "Siddhi Vinayak Stores", city: "Sehore", area: "Kasba", stateCode: "23", pincode: "466001",
    gstPan: "USVPM8836S", category: "Kirana", interval: 14, lastVisitDaysAgo: 15, creditLimit: 40000, creditDays: 21, lateness: 0.35,
    habits: [P("Parle-G", 48), P("Rin", 40), P("Vim", 24), P("Everest", 10), P("MDH", 10), P("Dabur Red", 12)],
  },
  {
    name: "Cash customer", businessName: "Walk-in / Counter sale", city: "Bhopal", area: "Govindpura", stateCode: "23", pincode: "462023",
    gstPan: null, category: "Walk-in", interval: 1, lastVisitDaysAgo: 0, creditLimit: 0, creditDays: 0, lateness: 0,
    habits: [P("Parle-G", 4), P("Tata Salt", 2, 2), P("Maggi", 6, 2), P("Coca-Cola", 2, 3), P("Amul Taaza", 2)],
  },
];

export const CUSTOMERS: Customer[] = PROFILES.map((p, i) => ({
  id: `c${i + 1}`,
  code: `C${String(i + 1).padStart(3, "0")}`,
  name: p.name,
  businessName: p.businessName,
  type: p.gstPan ? "b2b" : "b2c",
  mobile: `${pick(["98", "94", "70", "88", "99", "62"])}${String(between(10000000, 99999999))}`,
  gstin: p.gstPan ? makeGstin(p.stateCode, p.gstPan) : null,
  city: p.city,
  address: `${p.area}, ${p.city}`,
  stateCode: p.stateCode,
  pincode: p.pincode,
  creditLimit: p.creditLimit,
  creditDays: p.creditDays,
  category: p.category,
  route: ROUTES[i % ROUTES.length]!,
  salesRep: SALES_REPS[i % SALES_REPS.length]!,
  priceLevel: p.category === "Wholesaler" ? "wholesale" : "retail",
  openingBalance: 0,
}));
export const customerById = new Map(CUSTOMERS.map((c) => [c.id, c]));
export const WALK_IN_ID = CUSTOMERS.at(-1)!.id;

// ---------- Invoice history ----------
const HISTORY_DAYS = 180;
const invoices: Invoice[] = [];
const payments: Payment[] = [];
let invSeq = 0;
let rctSeq = 0;
const fyShort = (() => {
  const y = Number(TODAY.slice(0, 4));
  const m = Number(TODAY.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
})();

const METHODS: PaymentMethod[] = ["upi", "cash", "upi", "bank_transfer", "cheque", "upi", "cash"];

function priceFor(product: (typeof PRODUCTS)[number], customer: Customer) {
  return customer.priceLevel === "wholesale" ? product.wholesaleRate : product.rate;
}

export function invoiceTotals(lines: Invoice["lines"], date: string, customer: Customer) {
  const supplyType = customer.stateCode === BUSINESS.stateCode ? "intra_state" : "inter_state";
  return calculateDocument({
    supplyType,
    chargeTax: true,
    lines: lines.map((l, i) => {
      const product = productById.get(l.productId)!;
      const tax = product.taxCategory.kind === "taxable" ? resolveTax(product.taxCategory, { date }) : { ...NO_TAX, kind: product.taxCategory.kind };
      return { key: String(i), qty: l.qty, rate: l.rate, discountPercent: l.discountPercent, tax, hsnCode: product.hsn, uqc: product.uqc };
    }),
  });
}

PROFILES.forEach((profile, ci) => {
  const customer = CUSTOMERS[ci]!;
  const walkIn = customer.id === WALK_IN_ID;
  let dayAgo = profile.lastVisitDaysAgo;
  const visitDays: number[] = [];
  while (dayAgo <= HISTORY_DAYS) {
    visitDays.push(dayAgo);
    const jitter = profile.interval >= 7 ? between(-1, 1) : 0;
    dayAgo += Math.max(1, profile.interval + jitter);
  }
  visitDays.reverse(); // oldest first
  visitDays.forEach((ago, visitIndex) => {
    const date = addDays(TODAY, -ago);
    const fromEnd = visitDays.length - 1 - visitIndex;
    const lines: Invoice["lines"] = [];
    for (const habit of profile.habits) {
      if (habit.stoppedDaysAgo && ago < habit.stoppedDaysAgo) continue;
      if (fromEnd % habit.every !== 0) continue;
      const product = PRODUCTS.find((p) => p.name.startsWith(habit.product))!;
      const qty = rand() < 0.2 ? Math.max(1, Math.round(habit.qty * (0.75 + rand() * 0.6))) : habit.qty;
      lines.push({ productId: product.id, qty, rate: priceFor(product, customer), discountPercent: profile.category === "Wholesaler" ? 2 : 0 });
    }
    // Occasional extras; bread + butter and noodles + ketchup travel together.
    if (!walkIn && rand() < 0.35) {
      const extra = pick(PRODUCTS);
      if (!lines.some((l) => l.productId === extra.id)) lines.push({ productId: extra.id, qty: extra.caseSize, rate: priceFor(extra, customer), discountPercent: 0 });
    }
    const has = (prefix: string) => lines.some((l) => l.productId === pid(prefix));
    if (has("Britannia Bread") && !has("Amul Butter") && rand() < 0.7) {
      const butter = productById.get(pid("Amul Butter"))!;
      lines.push({ productId: butter.id, qty: 10, rate: priceFor(butter, customer), discountPercent: 0 });
    }
    if (has("Maggi") && !has("Kissan") && rand() < 0.45) {
      const ketchup = productById.get(pid("Kissan"))!;
      lines.push({ productId: ketchup.id, qty: 6, rate: priceFor(ketchup, customer), discountPercent: 0 });
    }
    if (lines.length === 0) return;
    const totals = invoiceTotals(lines, date, customer);
    const cost = lines.reduce((s, l) => s + productById.get(l.productId)!.purchasePrice * l.qty, 0);
    invSeq += 1;
    const total = totals.grandTotal.toNumber();
    const invoice: Invoice = {
      id: `i${invSeq}`,
      number: `INV/${fyShort}/${String(invSeq).padStart(5, "0")}`,
      date,
      dueDate: addDays(date, customer.creditDays),
      customerId: customer.id,
      lines,
      taxable: totals.taxableTotal.toNumber(),
      tax: totals.taxTotal.toNumber(),
      total,
      cost: Math.round(cost * 100) / 100,
      paid: 0,
      settledOn: null,
    };
    invoices.push(invoice);

    // Payment behaviour: walk-in pays now; others pay around the due date, late payers later (or not yet).
    if (walkIn || customer.creditDays === 0) {
      invoice.paid = total;
      invoice.settledOn = date;
      rctSeq += 1;
      payments.push({
        id: `r${rctSeq}`,
        number: `RCT/${fyShort}/${String(rctSeq).padStart(5, "0")}`,
        date,
        customerId: customer.id,
        amount: total,
        method: rand() < 0.6 ? "cash" : "upi",
        reference: "",
      });
      return;
    }
    const delay = Math.round(customer.creditDays * (0.3 + profile.lateness * (0.6 + rand() * 1.8)));
    const payDate = addDays(date, delay);
    if (payDate > TODAY) return;
    const partial = rand() < 0.12;
    const amount = partial ? Math.round(total * 0.5) : total;
    rctSeq += 1;
    payments.push({
      id: `r${rctSeq}`,
      number: `RCT/${fyShort}/${String(rctSeq).padStart(5, "0")}`,
      date: payDate,
      customerId: customer.id,
      amount,
      method: pick(METHODS),
      reference: amount > 20000 ? `UTR${between(100000000, 999999999)}` : "",
    });
    invoice.paid = amount;
    invoice.settledOn = partial ? null : payDate;
  });
});

invoices.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
payments.sort((a, b) => a.date.localeCompare(b.date));

export const INVOICES: Invoice[] = invoices;
export const PAYMENTS: Payment[] = payments;
export const NEXT_INVOICE_NUMBER = `INV/${fyShort}/${String(invSeq + 1).padStart(5, "0")}`;
export const FY_SHORT = fyShort;

export function outstandingFor(customerId: string): number {
  return INVOICES.filter((i) => i.customerId === customerId).reduce((s, i) => s + (i.total - i.paid), 0);
}

// ---------- Purchases, expenses, orders (aggregates for the dashboard) ----------
export const PURCHASES_BY_DAY: DayAmount[] = Array.from({ length: HISTORY_DAYS + 1 }, (_, i) => {
  const date = addDays(TODAY, -i);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  // Stock arrives twice a week from company depots, plus small top-up purchases.
  const amount = weekday === 1 || weekday === 4 ? between(38000, 72000) : rand() < 0.3 ? between(4000, 18000) : 0;
  return { date, amount };
});

export const EXPENSES_BY_DAY: DayAmount[] = Array.from({ length: HISTORY_DAYS + 1 }, (_, i) => ({
  date: addDays(TODAY, -i),
  amount: between(800, 4200),
}));

export const PAYABLE_OUTSTANDING = 248300;

const orderCustomers = CUSTOMERS.slice(0, 18);
const ORDER_STATUSES: Order["status"][] = ["pending", "pending", "confirmed", "confirmed", "packing", "packed", "packed", "dispatched"];
export const ORDERS: Order[] = orderCustomers.map((c, i) => ({
  id: `o${i + 1}`,
  number: `SO/${fyShort}/${String(2400 + i).padStart(5, "0")}`,
  date: addDays(TODAY, -between(0, 2)),
  customerId: c.id,
  status: ORDER_STATUSES[i % ORDER_STATUSES.length]!,
  items: between(4, 14),
  value: between(4000, 48000),
}));
