import { PAPER_DOTS, receiptBytes, type PaperWidth } from "@digitalbahi/core";
import { nativePlugin } from "../../platform/native";
import { canvasBitmap, drawReceipt, type ReceiptItem } from "./draw";

/**
 * The thermal printer this device prints receipts on, and the way to it:
 * Bluetooth Low Energy from the browser (Chrome on Android, Windows, Mac),
 * or, in the Android app, classic Bluetooth (the "serial port" most cheap
 * printers speak) through the app. Which printer and the paper width are
 * kept on the device; nothing of it goes to the server.
 */

export type PrinterKind = "ble" | "native";
export interface PrinterChoice {
  kind: PrinterKind;
  /** The browser's id for a Bluetooth device, or the printer's Bluetooth address in the app. */
  id: string;
  name: string;
}
export interface PrinterSettings {
  paper: PaperWidth;
  printer: PrinterChoice | null;
}

export class PrinterError extends Error {
  constructor(readonly code: "unsupported" | "cancelled" | "not_found" | "no_writer" | "write_failed") {
    super(code);
  }
}

const KEY = "digitalbahi.printer";
const listeners = new Set<() => void>();

export function printerSettings(): PrinterSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<PrinterSettings> | null;
    return { paper: v?.paper === 80 ? 80 : 58, printer: v?.printer ?? null };
  } catch {
    return { paper: 58, printer: null };
  }
}

export function savePrinterSettings(patch: Partial<PrinterSettings>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...printerSettings(), ...patch }));
  } catch {
    // Storage blocked: the choice lasts until the page closes.
  }
  listeners.forEach((l) => l());
}

export function onPrinterChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// --- In the Android app: classic Bluetooth through the app. ---

interface NativePrinter {
  list(): Promise<{ devices: Array<{ name: string; address: string }> }>;
  print(o: { address: string; data: string }): Promise<void>;
}
const nativePrinter = () => nativePlugin<NativePrinter>("ThermalPrinter");

/** Printers paired with the phone (in the app). */
export async function pairedPrinters(): Promise<PrinterChoice[]> {
  const plugin = nativePrinter();
  if (!plugin) return [];
  const { devices } = await plugin.list();
  return devices.map((d) => ({ kind: "native" as const, id: d.address, name: d.name || d.address }));
}

// --- In the browser: Bluetooth Low Energy (Web Bluetooth). ---

interface GattCharacteristic {
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValueWithResponse(data: BufferSource): Promise<void>;
  writeValueWithoutResponse(data: BufferSource): Promise<void>;
}
interface GattService {
  getCharacteristics(): Promise<GattCharacteristic[]>;
}
interface GattServer {
  connected: boolean;
  connect(): Promise<GattServer>;
  getPrimaryServices(): Promise<GattService[]>;
}
interface BleDevice {
  id: string;
  name?: string;
  gatt?: GattServer;
}
interface WebBluetooth {
  requestDevice(o: { acceptAllDevices: boolean; optionalServices: Array<number | string> }): Promise<BleDevice>;
  getDevices?(): Promise<BleDevice[]>;
}
const bluetooth = () => (typeof navigator !== "undefined" && window.isSecureContext ? (navigator as { bluetooth?: WebBluetooth }).bluetooth : undefined);

/** The services thermal printers send data on (the common Chinese modules and the Microchip "transparent UART"). */
const PRINTER_SERVICES: Array<number | string> = [
  0x18f0,
  0xff00,
  0xffe0,
  0xfee7,
  0xae30,
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
];

let ble: { device: BleDevice; writer: GattCharacteristic } | null = null;

async function writerOf(device: BleDevice): Promise<GattCharacteristic> {
  if (!device.gatt) throw new PrinterError("not_found");
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  for (const service of await server.getPrimaryServices()) {
    for (const c of await service.getCharacteristics()) if (c.properties.writeWithoutResponse || c.properties.write) return c;
  }
  throw new PrinterError("no_writer");
}

/** Whether this device can print to a thermal printer at all. */
export const thermalSupported = () => Boolean(nativePrinter() || bluetooth());

/** Looks for a Bluetooth printer (the browser lists those nearby) and keeps it as this device's printer. */
export async function chooseBluetoothPrinter(): Promise<PrinterChoice> {
  const bt = bluetooth();
  if (!bt) throw new PrinterError("unsupported");
  let device: BleDevice;
  try {
    device = await bt.requestDevice({ acceptAllDevices: true, optionalServices: PRINTER_SERVICES });
  } catch {
    throw new PrinterError("cancelled");
  }
  ble = { device, writer: await writerOf(device) };
  const choice: PrinterChoice = { kind: "ble", id: device.id, name: device.name || "Bluetooth printer" };
  savePrinterSettings({ printer: choice });
  return choice;
}

async function bleWriter(choice: PrinterChoice): Promise<GattCharacteristic> {
  if (ble && ble.device.id === choice.id) {
    if (ble.device.gatt?.connected) return ble.writer;
    ble = { device: ble.device, writer: await writerOf(ble.device) };
    return ble.writer;
  }
  // Chosen before (another visit): the browser may still know it; else it is chosen again.
  const known = (await bluetooth()?.getDevices?.().catch(() => []))?.find((d) => d.id === choice.id);
  if (!known) throw new PrinterError("not_found");
  ble = { device: known, writer: await writerOf(known) };
  return ble.writer;
}

/** Bytes to the printer in small pieces (cheap printers have tiny buffers). */
async function bleWrite(writer: GattCharacteristic, bytes: Uint8Array): Promise<void> {
  const CHUNK = 180;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.slice(i, i + CHUNK);
    if (writer.properties.writeWithoutResponse) {
      await writer.writeValueWithoutResponse(part);
      // Give the printer time to take it in.
      await new Promise((r) => setTimeout(r, 12));
    } else await writer.writeValueWithResponse(part);
  }
}

const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Sends bytes to this device's printer. */
export async function sendToPrinter(bytes: Uint8Array): Promise<void> {
  const { printer } = printerSettings();
  if (!printer) throw new PrinterError("not_found");
  try {
    if (printer.kind === "native") {
      const plugin = nativePrinter();
      if (!plugin) throw new PrinterError("unsupported");
      await plugin.print({ address: printer.id, data: base64(bytes) });
    } else await bleWrite(await bleWriter(printer), bytes);
  } catch (e) {
    if (e instanceof PrinterError) throw e;
    ble = null;
    throw new PrinterError("write_failed");
  }
}

/** Draws a receipt for this device's paper and prints it. */
export async function printReceipt(items: ReceiptItem[]): Promise<void> {
  const canvas = await drawReceipt(items, PAPER_DOTS[printerSettings().paper]);
  await sendToPrinter(receiptBytes(canvasBitmap(canvas)));
}
