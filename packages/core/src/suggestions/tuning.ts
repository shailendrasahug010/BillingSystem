import { DEFAULT_WEIGHTS, type SuggestionGroup } from "./engine.js";

/**
 * Tuning the suggestion weights from what the billing screen offered and what
 * was taken (Phase 5.1). Items higher in the list are taken more whatever
 * their group, so each group is judged against what its positions would get:
 * the take rate of every position over all groups gives the takes a group
 * should have had for where its items were shown; a group taken more than
 * that gains weight, one taken less loses it. The lift is shrunk towards 1
 * while there are few offers, kept within half and double the default, and a
 * group shown too rarely keeps its default.
 */

export const SUGGESTION_GROUPS: readonly SuggestionGroup[] = ["reorder", "frequent", "together", "last_order"];

/** Offers and takes of one group at one position (1 = first in the list). */
export interface FeedbackCount {
  group: string;
  rank: number;
  shown: number;
  added: number;
}

export interface TuningOptions {
  /** A group shown fewer times than this keeps its default weight. */
  minShown?: number;
  /** Pseudo-takes pulling the lift towards 1 (more data, less pull). */
  prior?: number;
  /** The lift is kept within [1 / maxFactor, maxFactor]. */
  maxFactor?: number;
  defaults?: Readonly<Record<SuggestionGroup, number>>;
}

export interface GroupTuning {
  shown: number;
  added: number;
  /** Takes the group's positions would get at the average take rate of those positions. */
  expected: number;
  /** added / expected, shrunk towards 1 and kept in range; 1 when not tuned. */
  lift: number;
  tuned: boolean;
}

export interface WeightTuning {
  weights: Record<SuggestionGroup, number>;
  groups: Record<SuggestionGroup, GroupTuning>;
  /** At least one group was tuned. */
  tuned: boolean;
}

/** Positions 1–3, 4–6, 7–12 and 13 on are compared as buckets (single positions are too thin). */
export function rankBucket(rank: number): number {
  return rank <= 3 ? 0 : rank <= 6 ? 1 : rank <= 12 ? 2 : 3;
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

export function tuneSuggestionWeights(counts: readonly FeedbackCount[], options: TuningOptions = {}): WeightTuning {
  const minShown = options.minShown ?? 50;
  const prior = options.prior ?? 10;
  const maxFactor = options.maxFactor ?? 2;
  const defaults = options.defaults ?? DEFAULT_WEIGHTS;
  // Take rate per position bucket, over every group.
  const byBucket = new Map<number, { shown: number; added: number }>();
  for (const c of counts) {
    const b = byBucket.get(rankBucket(c.rank)) ?? { shown: 0, added: 0 };
    b.shown += c.shown;
    b.added += c.added;
    byBucket.set(rankBucket(c.rank), b);
  }
  const rate = (rank: number) => {
    const b = byBucket.get(rankBucket(rank));
    return b && b.shown ? b.added / b.shown : 0;
  };
  const groups = {} as Record<SuggestionGroup, GroupTuning>;
  const weights = {} as Record<SuggestionGroup, number>;
  let tuned = false;
  for (const g of SUGGESTION_GROUPS) {
    const mine = counts.filter((c) => c.group === g);
    const shown = mine.reduce((a, c) => a + c.shown, 0);
    const added = mine.reduce((a, c) => a + c.added, 0);
    const expected = mine.reduce((a, c) => a + c.shown * rate(c.rank), 0);
    const enough = shown >= minShown && expected > 0;
    const raw = enough ? (added + prior) / (expected + prior) : 1;
    const lift = Math.min(maxFactor, Math.max(1 / maxFactor, raw));
    groups[g] = { shown, added, expected: round(expected, 2), lift: round(lift, 3), tuned: enough };
    weights[g] = round(defaults[g] * lift, 3);
    tuned ||= enough;
  }
  return { weights, groups, tuned };
}
