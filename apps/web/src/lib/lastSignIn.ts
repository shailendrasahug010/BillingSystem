/** The mobile number or email last signed in with on this device, filled in next time. */
const LAST_ID = "digitalbahi:last-sign-in";
/** That person's name, for "Welcome back, Ramesh". */
const LAST_NAME = "digitalbahi:last-sign-in-name";
/** Set by Sign out, read once by the sign-in screen: "You're signed out". */
const SIGNED_OUT = "digitalbahi:signed-out";
/** Set by sign-up, cleared when the welcome card is closed: the business just created. */
const WELCOME = "digitalbahi:welcome";

function read(key: string, store: () => Storage = () => localStorage): string {
  try {
    return store().getItem(key) ?? "";
  } catch {
    return "";
  }
}
function write(key: string, value: string | null, store: () => Storage = () => localStorage): void {
  try {
    if (value) store().setItem(key, value);
    else store().removeItem(key);
  } catch {
    // Private windows: nothing remembered.
  }
}

export function lastSignIn(): string {
  return read(LAST_ID);
}
export function rememberSignIn(identifier: string | null): void {
  write(LAST_ID, identifier);
  if (!identifier) write(LAST_NAME, null);
}

export const lastSignInName = (): string => read(LAST_NAME);
export const rememberSignInName = (name: string | null): void => write(LAST_NAME, name);

/** Sign out leaves a note for the sign-in screen, which clears it once shown. */
export const markSignedOut = (): void => write(SIGNED_OUT, "1", () => sessionStorage);
export const wasSignedOut = (): boolean => read(SIGNED_OUT, () => sessionStorage) === "1";
export const clearSignedOut = (): void => write(SIGNED_OUT, null, () => sessionStorage);

export const welcomeBusiness = (): string => read(WELCOME);
export const setWelcomeBusiness = (name: string | null): void => write(WELCOME, name);
