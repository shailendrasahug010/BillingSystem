import { financialYearOf, formatDocumentNumber } from "@digitalbahi/core";
import { api } from "../lib/api";
import { idbGet, idbKeys, idbPut } from "./idb";

/**
 * This phone or PC as the server knows it: a short code (A1, A2 …) and its
 * own invoice series, so bills made offline get their final numbers at once
 * and never collide with the office counter or another phone.
 */
export interface DeviceRecord {
  id: string;
  userId: string;
  businessId: string;
  seriesCode: string;
  pattern: string;
  financialYearStartMonth: number;
  /** Next number per financial year ("2026-27" → 4). */
  counters: Record<string, number>;
  /** Asks the server, signed in or not, whether the owner removed this device (then its copy is wiped). */
  checkSecret?: string;
}

interface DeviceResponse {
  id: string;
  /** Null for people who do not bill: the device is registered only so it can be removed. */
  seriesCode: string | null;
  pattern: string;
  financialYearStartMonth: number;
  series: { financialYear: string; nextNumber: number } | null;
  checkSecret: string;
}

type Platform = "web" | "android" | "ios" | "windows" | "mac" | "linux";

const key = (userId: string, businessId: string) => `device:${userId}:${businessId}`;

function platform(): Platform {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Linux/i.test(ua)) return "linux";
  return "web";
}

const PLATFORM_NAMES: Record<Platform, string> = { android: "Android phone", ios: "iPhone / iPad", windows: "Windows PC", mac: "Mac", linux: "Linux PC", web: "Browser" };

function deviceName(p: Platform): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${PLATFORM_NAMES[p]} · ${browser}` : PLATFORM_NAMES[p];
}

/** Runs `fn` alone across the app's open tabs (where the browser supports locks). */
function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: { request(n: string, cb: () => Promise<T>): Promise<T> } }).locks;
  return locks ? locks.request(name, fn) : fn();
}

export function loadDevice(userId: string, businessId: string): Promise<DeviceRecord | undefined> {
  return idbGet<DeviceRecord>("kv", key(userId, businessId));
}

/**
 * Registers (or re-confirms) this device while online and brings its number
 * counters up to what the server has seen. Only done where the device can
 * keep the record: without storage there is no offline billing.
 */
export async function ensureDevice(userId: string, businessId: string): Promise<DeviceRecord | undefined> {
  const saved = await loadDevice(userId, businessId);
  if (!saved && !(await idbPut("kv", true, "probe"))) return undefined;
  const p = platform();
  let res: DeviceResponse;
  try {
    res = await api.post<DeviceResponse>("/devices", { name: deviceName(p), platform: p, ...(saved?.id ? { deviceId: saved.id } : {}) });
  } catch {
    return saved;
  }
  return exclusive("digital-bahi-numbers", async () => {
    const current = await loadDevice(userId, businessId);
    const sameDevice = current?.id === res.id;
    const counters = sameDevice ? { ...current.counters } : {};
    if (res.series) counters[res.series.financialYear] = Math.max(counters[res.series.financialYear] ?? 1, res.series.nextNumber);
    const record: DeviceRecord = {
      id: res.id,
      userId,
      businessId,
      seriesCode: res.seriesCode ?? "",
      pattern: res.pattern,
      financialYearStartMonth: res.financialYearStartMonth,
      counters,
      checkSecret: res.checkSecret,
    };
    await idbPut("kv", record, key(userId, businessId));
    return record;
  });
}

/**
 * Asks the server about each device record kept here (signed in or not) and
 * returns those the owner removed: their copy is to be wiped. Without a
 * server nothing is learnt.
 */
export async function removedDevices(): Promise<DeviceRecord[]> {
  const out: DeviceRecord[] = [];
  for (const k of (await idbKeys("kv")).filter((x) => x.startsWith("device:"))) {
    const device = await idbGet<DeviceRecord>("kv", k);
    if (!device?.checkSecret) continue;
    try {
      const res = await api.post<{ status: string }>("/devices/check", { deviceId: device.id, secret: device.checkSecret }, { signal: AbortSignal.timeout(5000) });
      if (res.status === "removed") out.push(device);
    } catch {
      return out;
    }
  }
  return out;
}

/** Hands out the device's next invoice number for a bill dated `date`, and remembers it is used. */
export async function takeOfflineNumber(userId: string, businessId: string, date: string): Promise<{ device: DeviceRecord; number: string } | null> {
  return exclusive("digital-bahi-numbers", async () => {
    const device = await loadDevice(userId, businessId);
    if (!device?.seriesCode) return null;
    const fy = financialYearOf(date, device.financialYearStartMonth).label;
    const seq = device.counters[fy] ?? 1;
    const number = formatDocumentNumber(device.pattern, { seq, date, financialYearStartMonth: device.financialYearStartMonth, deviceCode: device.seriesCode });
    const next = { ...device, counters: { ...device.counters, [fy]: seq + 1 } };
    if (!(await idbPut("kv", next, key(userId, businessId)))) return null;
    return { device: next, number };
  });
}

/** The number the next offline bill dated `date` will get (shown on the bill form). */
export function peekOfflineNumber(device: DeviceRecord, date: string): string {
  const fy = financialYearOf(date, device.financialYearStartMonth).label;
  return formatDocumentNumber(device.pattern, { seq: device.counters[fy] ?? 1, date, financialYearStartMonth: device.financialYearStartMonth, deviceCode: device.seriesCode });
}
