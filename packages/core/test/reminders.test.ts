import { describe, expect, it } from "vitest";
import { customerReminderDue, isReminderType, NOTIFICATION_PERMISSIONS, REMINDER_TYPES, REMINDERS, reminderConfig } from "../src/index.js";

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
    expect(reminderConfig("orders_waiting", { afterHours: 2 })).toEqual({ hour: 9, afterHours: 2 });
    expect(reminderConfig("customer_reminders", { firstAfterDays: 3, repeatDays: 0, maxCount: 2, minAmount: 500.5, channel: "sms" })).toEqual({
      hour: 10,
      firstAfterDays: 3,
      repeatDays: 7,
      maxCount: 2,
      minAmount: 100,
      channel: "sms",
    });
    expect(reminderConfig("customer_reminders", { channel: "pigeon" }).channel).toBe("whatsapp_or_sms");
  });

  it("know their types, each with the permission whose holders are told", () => {
    expect(REMINDER_TYPES).toHaveLength(12);
    expect(REMINDER_TYPES.every(isReminderType)).toBe(true);
    expect(isReminderType("nonsense")).toBe(false);
    expect(new Set(NOTIFICATION_PERMISSIONS)).toEqual(new Set([...REMINDER_TYPES.map((t) => REMINDERS[t].permission), "invoice.review"]));
    // Rules raised as things happen as well as by the daily check.
    expect(REMINDER_TYPES.filter((t) => REMINDERS[t].events)).toEqual(["pending_orders", "to_pack", "to_dispatch", "leave_request"]);
  });
});

describe("automatic payment reminders to customers", () => {
  const config = reminderConfig("customer_reminders", { firstAfterDays: 2, repeatDays: 7, maxCount: 3 });
  const due = (today: string, sentSinceDue = 0, lastSentOn: string | null = null) => customerReminderDue({ today, oldestDue: "2026-09-10", sentSinceDue, lastSentOn, config });

  it("wait the days after the bill fell due before the first", () => {
    expect(due("2026-09-11")).toEqual({ due: false, reason: "not_yet", daysOverdue: 1 });
    expect(due("2026-09-12")).toEqual({ due: true, reason: "due", daysOverdue: 2 });
  });

  it("repeat every so many days, up to the most allowed", () => {
    expect(due("2026-09-18", 1, "2026-09-12")).toMatchObject({ due: false, reason: "too_soon" });
    expect(due("2026-09-19", 1, "2026-09-12")).toMatchObject({ due: true });
    expect(due("2026-10-30", 3, "2026-09-26")).toMatchObject({ due: false, reason: "enough" });
  });
});
