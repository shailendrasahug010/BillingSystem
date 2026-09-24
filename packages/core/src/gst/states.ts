/**
 * GST state / UT codes (first two digits of a GSTIN and the "place of supply" code).
 *
 * `component` decides the name of the state-side tax on an intra-state supply:
 * Union Territories without a legislature levy UTGST instead of SGST.
 * This list is *reference data*: it is seeded into the `states` table and can be
 * corrected there without a code change (e.g. codes 25/26 were merged in 2020).
 */
export type StateTaxComponent = "SGST" | "UTGST";

export interface GstState {
  code: string;
  name: string;
  nameHi: string;
  kind: "state" | "ut" | "special";
  component: StateTaxComponent;
  /** Codes kept for historical documents only (e.g. pre-merger / pre-bifurcation). */
  legacy?: boolean;
}

export const GST_STATES: readonly GstState[] = [
  { code: "01", name: "Jammu and Kashmir", nameHi: "जम्मू और कश्मीर", kind: "ut", component: "SGST" },
  { code: "02", name: "Himachal Pradesh", nameHi: "हिमाचल प्रदेश", kind: "state", component: "SGST" },
  { code: "03", name: "Punjab", nameHi: "पंजाब", kind: "state", component: "SGST" },
  { code: "04", name: "Chandigarh", nameHi: "चंडीगढ़", kind: "ut", component: "UTGST" },
  { code: "05", name: "Uttarakhand", nameHi: "उत्तराखंड", kind: "state", component: "SGST" },
  { code: "06", name: "Haryana", nameHi: "हरियाणा", kind: "state", component: "SGST" },
  { code: "07", name: "Delhi", nameHi: "दिल्ली", kind: "ut", component: "SGST" },
  { code: "08", name: "Rajasthan", nameHi: "राजस्थान", kind: "state", component: "SGST" },
  { code: "09", name: "Uttar Pradesh", nameHi: "उत्तर प्रदेश", kind: "state", component: "SGST" },
  { code: "10", name: "Bihar", nameHi: "बिहार", kind: "state", component: "SGST" },
  { code: "11", name: "Sikkim", nameHi: "सिक्किम", kind: "state", component: "SGST" },
  { code: "12", name: "Arunachal Pradesh", nameHi: "अरुणाचल प्रदेश", kind: "state", component: "SGST" },
  { code: "13", name: "Nagaland", nameHi: "नागालैंड", kind: "state", component: "SGST" },
  { code: "14", name: "Manipur", nameHi: "मणिपुर", kind: "state", component: "SGST" },
  { code: "15", name: "Mizoram", nameHi: "मिज़ोरम", kind: "state", component: "SGST" },
  { code: "16", name: "Tripura", nameHi: "त्रिपुरा", kind: "state", component: "SGST" },
  { code: "17", name: "Meghalaya", nameHi: "मेघालय", kind: "state", component: "SGST" },
  { code: "18", name: "Assam", nameHi: "असम", kind: "state", component: "SGST" },
  { code: "19", name: "West Bengal", nameHi: "पश्चिम बंगाल", kind: "state", component: "SGST" },
  { code: "20", name: "Jharkhand", nameHi: "झारखंड", kind: "state", component: "SGST" },
  { code: "21", name: "Odisha", nameHi: "ओडिशा", kind: "state", component: "SGST" },
  { code: "22", name: "Chhattisgarh", nameHi: "छत्तीसगढ़", kind: "state", component: "SGST" },
  { code: "23", name: "Madhya Pradesh", nameHi: "मध्य प्रदेश", kind: "state", component: "SGST" },
  { code: "24", name: "Gujarat", nameHi: "गुजरात", kind: "state", component: "SGST" },
  { code: "25", name: "Daman and Diu", nameHi: "दमन और दीव", kind: "ut", component: "UTGST", legacy: true },
  {
    code: "26",
    name: "Dadra and Nagar Haveli and Daman and Diu",
    nameHi: "दादरा और नगर हवेली और दमन और दीव",
    kind: "ut",
    component: "UTGST",
  },
  { code: "27", name: "Maharashtra", nameHi: "महाराष्ट्र", kind: "state", component: "SGST" },
  { code: "28", name: "Andhra Pradesh (Old)", nameHi: "आंध्र प्रदेश (पुराना)", kind: "state", component: "SGST", legacy: true },
  { code: "29", name: "Karnataka", nameHi: "कर्नाटक", kind: "state", component: "SGST" },
  { code: "30", name: "Goa", nameHi: "गोवा", kind: "state", component: "SGST" },
  { code: "31", name: "Lakshadweep", nameHi: "लक्षद्वीप", kind: "ut", component: "UTGST" },
  { code: "32", name: "Kerala", nameHi: "केरल", kind: "state", component: "SGST" },
  { code: "33", name: "Tamil Nadu", nameHi: "तमिलनाडु", kind: "state", component: "SGST" },
  { code: "34", name: "Puducherry", nameHi: "पुडुचेरी", kind: "ut", component: "SGST" },
  { code: "35", name: "Andaman and Nicobar Islands", nameHi: "अंडमान और निकोबार द्वीप समूह", kind: "ut", component: "UTGST" },
  { code: "36", name: "Telangana", nameHi: "तेलंगाना", kind: "state", component: "SGST" },
  { code: "37", name: "Andhra Pradesh", nameHi: "आंध्र प्रदेश", kind: "state", component: "SGST" },
  { code: "38", name: "Ladakh", nameHi: "लद्दाख", kind: "ut", component: "UTGST" },
  { code: "96", name: "Foreign Country", nameHi: "विदेश", kind: "special", component: "UTGST" },
  { code: "97", name: "Other Territory", nameHi: "अन्य क्षेत्र", kind: "special", component: "UTGST" },
];

const BY_CODE = new Map(GST_STATES.map((s) => [s.code, s]));

export function findState(code: string | null | undefined): GstState | undefined {
  if (!code) return undefined;
  return BY_CODE.get(code.padStart(2, "0"));
}

export function isKnownStateCode(code: string | null | undefined): boolean {
  return findState(code) !== undefined;
}

/** Name of the state-side tax (SGST or UTGST) for an intra-state supply in `stateCode`. */
export function stateTaxComponent(stateCode: string, states: readonly GstState[] = GST_STATES): StateTaxComponent {
  const state = states.find((s) => s.code === stateCode.padStart(2, "0"));
  return state?.component ?? "SGST";
}
