import { describe, expect, it } from "vitest";
import { dueRepeatDates, MAX_REPEAT_CATCH_UP, nextRepeatDate } from "../src/index.js";

describe("repeat bills", () => {
  it("moves a week or a month on", () => {
    expect(nextRepeatDate("weekly", "2026-12-28", 1)).toBe("2027-01-04");
    expect(nextRepeatDate("monthly", "2026-10-05", 5)).toBe("2026-11-05");
    expect(nextRepeatDate("monthly", "2026-12-15", 15)).toBe("2027-01-15");
  });

  it("keeps a month-end bill on the month's last day, then back on its own day", () => {
    expect(nextRepeatDate("monthly", "2026-01-31", 31)).toBe("2026-02-28");
    expect(nextRepeatDate("monthly", "2026-02-28", 31)).toBe("2026-03-31");
    expect(nextRepeatDate("monthly", "2028-01-30", 30)).toBe("2028-02-29");
  });

  it("lists the dates due, stopping at the end date and at the catch-up limit", () => {
    expect(dueRepeatDates("monthly", "2026-08-01", 1, "2026-10-05", null)).toEqual({ dates: ["2026-08-01", "2026-09-01", "2026-10-01"], next: "2026-11-01" });
    expect(dueRepeatDates("monthly", "2026-08-01", 1, "2026-10-05", "2026-09-15")).toEqual({ dates: ["2026-08-01", "2026-09-01"], next: "2026-10-01" });
    expect(dueRepeatDates("weekly", "2026-10-06", 2, "2026-10-05", null)).toEqual({ dates: [], next: "2026-10-06" });
    expect(dueRepeatDates("weekly", "2025-01-01", 3, "2026-10-05", null).dates).toHaveLength(MAX_REPEAT_CATCH_UP);
  });
});
