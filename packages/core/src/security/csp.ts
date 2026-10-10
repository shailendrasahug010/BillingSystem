/**
 * The Content-Security-Policy of the web app's pages, wherever they are
 * served from: deploy/Caddyfile (a server), the API itself (one computer,
 * apps/api/src/lib/webApp.ts) and `vite preview` (the production build in the
 * browser tests). The API's tests check that the Caddyfile says the same.
 *
 * Only the app's own origin may run scripts, so injected markup cannot run
 * code or send data elsewhere. The exceptions are what the app itself needs:
 * - 'wasm-unsafe-eval': the barcode reader is WebAssembly;
 * - 'unsafe-inline' styles: React's style attributes and print layouts;
 * - data: and blob: images, frames and workers: logos, photos being read,
 *   PDFs printed from a hidden frame, the PDF and image readers' workers.
 * No upgrade-insecure-requests: a one-computer install is reached over plain
 * http on the shop's Wi-Fi.
 */
export const WEB_APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");
