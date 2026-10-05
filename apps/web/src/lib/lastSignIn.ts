/** The mobile number or email last signed in with on this device, filled in next time. */
const LAST_ID = "digitalbahi:last-sign-in";
export function lastSignIn(): string {
  try {
    return localStorage.getItem(LAST_ID) ?? "";
  } catch {
    return "";
  }
}
export function rememberSignIn(identifier: string | null): void {
  try {
    if (identifier) localStorage.setItem(LAST_ID, identifier);
    else localStorage.removeItem(LAST_ID);
  } catch {
    // Private windows: nothing remembered.
  }
}
