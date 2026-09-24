/** True when the app runs inside another page's frame (e.g. a shared preview), where print dialogs are unavailable. */
export const EMBEDDED = (() => {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    return true;
  }
})();
