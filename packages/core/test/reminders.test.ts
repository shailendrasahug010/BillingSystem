import { describe, expect, it } from "vitest";
import { isReminderType, NOTIFICATION_PERMISSIONS, REMINDER_TYPES, REMINDERS, reminderConfig } from "../src/index.js";

describe("reminder rules", () => {
  it("fill in the defaults and keep only the settings that apply to the type", () => {
    expect(reminderConfig("customer_payment_due", null)).toEqual({ hour: 9, daysBefore: 3 });
    expect(reminderConfig("salary_due", {})).toEqual({ hour: 10, dayOfMonth: 1 });
    expect(reminderConfig("low_stock", { hour: 7, daysBefore: 5, dayOfMonth: 3 })).toEqual({ hour: 7 });
    expect(reminderConfig("supplier_payment_due", { hour: 0, daysBefore: 0 })).toEqual({ hour: 0, daysBefore: 0 });
  });

  it("put back the default for a value out of range or of the wrong kind", () => {
    expect(reminderConfig("customer_payment_due", { hour: 24, daysBefore: 31 })).toEqual({ hour: 9, daysBefore: 3 });
    expect(reminderConfig("salary_due", { hour: "8", dayOfMonth: 29 })).toEqual({ hour: 10, dayOfMonth: 1 });
    expect(reminderConfig("leave_request", { hour: 8.5 })).toEqual({ hour: 10 });
    expect(reminderConfig("devices_unsynced", { afterHours: 6 })).toEqual({ hour: 9, afterHours: 6 });
    expect(reminderConfig("devices_unsynced", { afterHours: 200 })).toEqual({ hour: 9, afterHours: 24 });
  });

  it("know their types, each with the permission whose holders are told", () => {
    expect(REMINDER_TYPES).toHaveLength(10);
    expect(REMINDER_TYPES.every(isReminderType)).toBe(true);
    expect(isReminderType("nonsense")).toBe(false);
    expect(new Set(NOTIFICATION_PERMISSIONS)).toEqual(new Set([...REMINDER_TYPES.map((t) => REMINDERS[t].permission), "invoice.review"]));
    // Rules raised as things happen as well as by the daily check.
    expect(REMINDER_TYPES.filter((t) => REMINDERS[t].events)).toEqual(["pending_orders", "to_pack", "to_dispatch", "leave_request"]);
  });
});
