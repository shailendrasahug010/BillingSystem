/** "Dewas", " dewas" and "DEWAS" are one place. */
export const cityKey = (city: string | null | undefined) => (city ?? "").trim().toLowerCase();

export interface CityGroup<T> {
  /** See cityKey; "" is the rows without a city. */
  key: string;
  /** The place as most of its rows write it ("Dewas" over "DEWAS" on a tie); null for no city. */
  label: string | null;
  rows: T[];
}

/** Neighbours together: by PIN code (those without one last), then name. */
export const byPinThenName = (a: { pincode: string; name: string }, b: { pincode: string; name: string }) =>
  Number(!a.pincode) - Number(!b.pincode) || a.pincode.localeCompare(b.pincode) || a.name.localeCompare(b.name);

/** Rows by place, each place where it first comes up and its rows in their order. */
export function byCity<T>(rows: readonly T[], city: (row: T) => string | null | undefined): CityGroup<T>[] {
  const groups = new Map<string, { rows: T[]; spellings: Map<string, number> }>();
  for (const row of rows) {
    const spelt = city(row)?.trim() ?? "";
    const key = cityKey(spelt);
    const g = groups.get(key) ?? { rows: [], spellings: new Map<string, number>() };
    g.rows.push(row);
    if (spelt) g.spellings.set(spelt, (g.spellings.get(spelt) ?? 0) + 1);
    groups.set(key, g);
  }
  // On a tie, "Dewas" over "dewas" over "DEWAS".
  const rank = (s: string) => (s === s.toUpperCase() ? 2 : s[0] === s[0]?.toUpperCase() ? 0 : 1);
  return [...groups].map(([key, g]) => ({
    key,
    label: [...g.spellings].sort(([a, n], [b, m]) => m - n || rank(a) - rank(b) || a.localeCompare(b))[0]?.[0] ?? null,
    rows: g.rows,
  }));
}
