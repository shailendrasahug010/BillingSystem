/**
 * Domain errors carry a stable machine-readable `code` plus `params`.
 * The UI never shows `message` directly: it looks up `errors.<code>` in the
 * active locale and interpolates `params`, so every business error is
 * translatable (English, Hindi, and any language added later).
 */
export class DomainError extends Error {
  readonly code: string;
  readonly params: Record<string, string | number>;

  constructor(code: string, message: string, params: Record<string, string | number> = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.params = params;
  }
}

export class ValidationError extends DomainError {
  constructor(code: string, message: string, params: Record<string, string | number> = {}) {
    super(code, message, params);
    this.name = "ValidationError";
  }
}
