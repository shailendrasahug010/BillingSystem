import { dec, type Dec, type DecimalInput, HUNDRED } from "../money/decimal.js";
import { DomainError } from "../errors.js";

/**
 * GST rates are DATA, not code.
 *
 * A product points at a tax category ("GST 5% - food", "Apparel", "Exempt").
 * Each category holds effective-dated rules. When the government changes a rate
 * (e.g. the 2025 slab rationalisation), an admin adds a new rule with an
 * `effectiveFrom` date; old invoices keep their snapshot and back-dated invoices
 * still resolve to the old rule. No deploy is needed.
 */
export type TaxabilityKind = "taxable" | "exempt" | "nil_rated" | "non_gst" | "zero_rated";

export interface TaxRateCondition {
  /** Rule applies only if the tax-exclusive value per unit is <= this amount. */
  unitValueLte?: DecimalInput;
  /** Rule applies only if the tax-exclusive value per unit is > this amount. */
  unitValueGt?: DecimalInput;
}

export interface TaxRateRule {
  id: string;
  /** ISO date (YYYY-MM-DD), inclusive. */
  effectiveFrom: string;
  /** ISO date (YYYY-MM-DD), inclusive. null/undefined = open ended. */
  effectiveTo?: string | null;
  /** Total GST rate in percent (the IGST-equivalent rate, split in half for CGST/SGST). */
  gstRate: DecimalInput;
  /** Ad-valorem compensation cess, percent. */
  cessRate?: DecimalInput;
  /** Specific cess in rupees per base unit (e.g. per 1000 sticks). */
  cessPerUnit?: DecimalInput;
  condition?: TaxRateCondition | null;
  /** Higher wins when several rules match (e.g. a conditional rule over a catch-all). */
  priority?: number;
}

export interface TaxCategory {
  id: string;
  name: string;
  kind: TaxabilityKind;
  rules: readonly TaxRateRule[];
}

/** The rate actually applied to a line; stored as a snapshot on the document line. */
export interface ResolvedTax {
  categoryId: string | null;
  ruleId: string | null;
  kind: TaxabilityKind;
  gstRate: Dec;
  cessRate: Dec;
  cessPerUnit: Dec;
}

export class TaxRuleNotFoundError extends DomainError {
  constructor(categoryName: string, date: string) {
    super("TAX_RULE_NOT_FOUND", `No GST rate is configured for "${categoryName}" on ${date}`, {
      category: categoryName,
      date,
    });
  }
}

export const NO_TAX: ResolvedTax = {
  categoryId: null,
  ruleId: null,
  kind: "non_gst",
  gstRate: dec(0),
  cessRate: dec(0),
  cessPerUnit: dec(0),
};

/** Build a resolved tax directly from a rate, e.g. for tests or an ad-hoc charge line. */
export function taxAt(gstRate: DecimalInput, cessRate: DecimalInput = 0): ResolvedTax {
  return {
    categoryId: null,
    ruleId: null,
    kind: "taxable",
    gstRate: dec(gstRate),
    cessRate: dec(cessRate),
    cessPerUnit: dec(0),
  };
}

function isEffectiveOn(rule: TaxRateRule, date: string): boolean {
  if (date < rule.effectiveFrom) return false;
  if (rule.effectiveTo && date > rule.effectiveTo) return false;
  return true;
}

function conditionHolds(condition: TaxRateCondition | null | undefined, unitValue: Dec | undefined): boolean {
  if (!condition) return true;
  if (unitValue === undefined) {
    // A value-conditional rule cannot be chosen without a value.
    return false;
  }
  if (condition.unitValueLte !== undefined && unitValue.gt(dec(condition.unitValueLte))) return false;
  if (condition.unitValueGt !== undefined && unitValue.lte(dec(condition.unitValueGt))) return false;
  return true;
}

export interface ResolveTaxOptions {
  /** Document date, ISO YYYY-MM-DD. The rate in force on this date is used. */
  date: string;
  /** Net value per unit, used by value-conditional rules. */
  unitValue?: DecimalInput;
  /** True when `unitValue` includes tax (MRP-style pricing); conditions are then tested on the tax-exclusive value. */
  unitValueIncludesTax?: boolean;
}

export function resolveTax(category: TaxCategory, options: ResolveTaxOptions): ResolvedTax {
  if (category.kind !== "taxable") {
    return { ...NO_TAX, categoryId: category.id, kind: category.kind };
  }
  const candidates = category.rules
    .filter((rule) => isEffectiveOn(rule, options.date))
    .filter((rule) => {
      if (options.unitValue === undefined) return !rule.condition;
      let value = dec(options.unitValue);
      if (options.unitValueIncludesTax) {
        const effective = dec(rule.gstRate).plus(dec(rule.cessRate ?? 0));
        value = value.dividedBy(HUNDRED.plus(effective).dividedBy(HUNDRED));
      }
      return conditionHolds(rule.condition, value);
    })
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        (b.condition ? 1 : 0) - (a.condition ? 1 : 0) ||
        b.effectiveFrom.localeCompare(a.effectiveFrom),
    );
  const rule = candidates[0];
  if (!rule) throw new TaxRuleNotFoundError(category.name, options.date);
  return {
    categoryId: category.id,
    ruleId: rule.id,
    kind: "taxable",
    gstRate: dec(rule.gstRate),
    cessRate: dec(rule.cessRate ?? 0),
    cessPerUnit: dec(rule.cessPerUnit ?? 0),
  };
}

export interface RuleOverlap {
  ruleIdA: string;
  ruleIdB: string;
}

/**
 * Admin-side check run before saving a category: two unconditional rules with the
 * same priority must not overlap in time, otherwise resolution would be ambiguous.
 */
export function findOverlappingRules(rules: readonly TaxRateRule[]): RuleOverlap[] {
  const overlaps: RuleOverlap[] = [];
  const plain = rules.filter((r) => !r.condition);
  for (let i = 0; i < plain.length; i++) {
    for (let j = i + 1; j < plain.length; j++) {
      const a = plain[i]!;
      const b = plain[j]!;
      if ((a.priority ?? 0) !== (b.priority ?? 0)) continue;
      const aEnd = a.effectiveTo ?? "9999-12-31";
      const bEnd = b.effectiveTo ?? "9999-12-31";
      if (a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd) overlaps.push({ ruleIdA: a.id, ruleIdB: b.id });
    }
  }
  return overlaps;
}
