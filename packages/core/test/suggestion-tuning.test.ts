import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, rankBucket, tuneSuggestionWeights, type FeedbackCount } from "../src/index.js";

const at = (group: string, rank: number, shown: number, added: number): FeedbackCount => ({ group, rank, shown, added });

describe("tuning the suggestion weights from what was taken", () => {
  it("keeps the defaults without enough offers", () => {
    expect(tuneSuggestionWeights([])).toEqual({
      weights: { ...DEFAULT_WEIGHTS },
      groups: Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((g) => [g, { shown: 0, added: 0, expected: 0, lift: 1, tuned: false }])),
      tuned: false,
    });
    // 40 offers of "together" are too few to judge (50 needed); the others are judged.
    const t = tuneSuggestionWeights([at("reorder", 1, 200, 80), at("frequent", 2, 200, 40), at("together", 3, 40, 20)]);
    expect(t.groups.together).toMatchObject({ shown: 40, tuned: false, lift: 1 });
    expect(t.weights.together).toBe(DEFAULT_WEIGHTS.together);
    expect(t.tuned).toBe(true);
  });

  it("raises a group taken more than its positions predict and lowers one taken less", () => {
    // Same positions (1–3) for both: the rate there is 120 / 400 = 30 %.
    const t = tuneSuggestionWeights([at("reorder", 1, 200, 90), at("frequent", 2, 200, 30)]);
    // reorder: expected 60, took 90 -> (90 + 10) / (60 + 10) = 1.429; frequent: (30 + 10) / 70 = 0.571.
    expect(t.groups.reorder).toEqual({ shown: 200, added: 90, expected: 60, lift: 1.429, tuned: true });
    expect(t.groups.frequent).toMatchObject({ expected: 60, lift: 0.571 });
    expect(t.weights.reorder).toBe(1.429);
    expect(t.weights.frequent).toBe(round(0.6 * 0.5714285714, 3));
  });

  it("does not reward a group for being shown first", () => {
    // "last_order" always at the top, taken at the top's usual rate; "together" low in the list but taken twice as often as items there.
    const t = tuneSuggestionWeights([at("last_order", 1, 300, 90), at("reorder", 2, 300, 90), at("together", 10, 300, 30), at("frequent", 9, 300, 15)]);
    expect(t.groups.last_order.lift).toBe(1);
    expect(t.groups.together.lift).toBeGreaterThan(1.2);
    expect(t.groups.frequent.lift).toBeLessThan(0.8);
  });

  it("keeps the change within half and double", () => {
    const t = tuneSuggestionWeights([at("reorder", 1, 1000, 1000), at("frequent", 1, 3000, 0)]);
    expect(t.groups.reorder.lift).toBe(2);
    expect(t.groups.frequent.lift).toBe(0.5);
    expect(t.weights).toMatchObject({ reorder: 2, frequent: 0.3 });
  });

  it("compares positions in buckets", () => {
    expect([1, 3, 4, 6, 7, 12, 13, 40].map(rankBucket)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
});

function round(n: number, places: number) {
  return Math.round(n * 10 ** places) / 10 ** places;
}
