import { useEffect, useSyncExternalStore } from "react";

/**
 * A screen lock for this device: a 4-digit PIN (and, where the device has
 * one, its fingerprint or face check) asked when the app opens and after it
 * has been in the background for a while, so a phone left on the counter or
 * lost while signed in does not show customers, dues and bills. It guards the
 * screen only; the data on the device is already encrypted (offline/vault.ts).
 * Kept per person on this device, in localStorage, as a salted PBKDF2 hash.
 */
export interface PinSettings {
  salt: string;
  hash: string;
  /** Locks after the app has been away this many minutes. */
  minutes: number;
  /** The device's own check (fingerprint, face, Windows Hello), as a WebAuthn credential id. */
  bio?: string;
}

export const LOCK_AFTER = [1, 5, 15, 60] as const;
export const PIN = /^\d{4}$/;
const ROUNDS = 100_000;
const keyFor = (userId: string) => `digitalbahi.pin.${userId}`;

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ROUNDS }, base, 256);
  return b64(bits);
}

export function readPin(userId: string | null | undefined): PinSettings | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(keyFor(userId));
    return raw ? (JSON.parse(raw) as PinSettings) : null;
  } catch {
    return null;
  }
}

function writePin(userId: string, settings: PinSettings | null): void {
  try {
    if (settings) localStorage.setItem(keyFor(userId), JSON.stringify(settings));
    else localStorage.removeItem(keyFor(userId));
  } catch {
    // Storage blocked: no lock can be kept on this device.
  }
  emit();
}

export async function setPin(userId: string, pin: string, minutes: number, bio?: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  writePin(userId, { salt: b64(salt), hash: await hashPin(pin, salt), minutes, ...(bio ? { bio } : {}) });
}

export function updatePin(userId: string, patch: Partial<Pick<PinSettings, "minutes" | "bio">>): void {
  const now = readPin(userId);
  if (!now) return;
  const next: PinSettings = { ...now, ...patch };
  if (!patch.bio && "bio" in patch) delete next.bio;
  writePin(userId, next);
}

export const removePin = (userId: string) => writePin(userId, null);

export async function pinMatches(userId: string, pin: string): Promise<boolean> {
  const s = readPin(userId);
  return Boolean(s && (await hashPin(pin, unb64(s.salt))) === s.hash);
}

/** Whether the device can check a fingerprint or face for this app (not inside the Android app's WebView). */
export async function bioAvailable(): Promise<boolean> {
  try {
    return typeof PublicKeyCredential !== "undefined" && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

/** Registers the device's own check for this person; the credential id, or null when it was refused. */
export async function enrolBio(userId: string, name: string): Promise<string | null> {
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Digital Bahi" },
        user: { id: new TextEncoder().encode(userId), name, displayName: name },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    return cred ? b64(cred.rawId) : null;
  } catch {
    return null;
  }
}

/** Asks for the fingerprint or face registered here; true when the device confirmed it. */
export async function checkBio(credentialId: string): Promise<boolean> {
  try {
    const got = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: unb64(credentialId) as BufferSource }],
        userVerification: "required",
        timeout: 60_000,
      },
    });
    return got !== null;
  } catch {
    return false;
  }
}

// Locked or not, for the whole page.
let locked = false;
let lockedFor: string | null = null;
const listeners = new Set<() => void>();
function emit(): void {
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function unlockScreen(): void {
  locked = false;
  emit();
}

/** Whether the screen is locked now for this person (only while they have a PIN). */
export function useScreenLocked(userId: string | null | undefined): boolean {
  const isLocked = useSyncExternalStore(subscribe, () => locked && lockedFor === userId && readPin(userId) !== null);
  useEffect(() => {
    if (!userId) return;
    // The app opened (or someone else signed in here): locked from the start when there is a PIN.
    if (lockedFor !== userId) {
      lockedFor = userId;
      locked = readPin(userId) !== null;
      emit();
    }
    let hiddenAt = 0;
    const seen = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const s = readPin(userId);
      if (s && hiddenAt && Date.now() - hiddenAt >= s.minutes * 60_000) {
        locked = true;
        emit();
      }
      hiddenAt = 0;
    };
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, [userId]);
  return isLocked;
}
