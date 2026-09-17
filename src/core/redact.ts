/**
 * Secret redaction for diagnostics (plan §31).
 *
 * The connector never *intentionally* logs credentials, but a future call site
 * could pass a raw header, request body or data URL through `log`/`warn`/
 * `error`, or embed one in an error message. Every diagnostic string is run
 * through `redactSecrets` before it reaches the console or the client, so the
 * "never log Authorization / access_token / client_secret / credentials / a
 * full uploaded file" invariant holds even under future mistakes.
 *
 * Redaction is deliberately over-eager: masking a benign value is acceptable,
 * leaking a secret is not.
 */

/** Replacement marker for any redacted value. */
export const REDACTED = "***";

/** Inline base64 data URLs carry the whole (possibly large) uploaded file. */
const DATA_URL_PATTERN = /data:([A-Za-z0-9\-+./]+);base64,[A-Za-z0-9+/=]+/g;

/**
 * `Authorization: <scheme> <value>` — masks the entire header value. Quotes may
 * be backslash-escaped when the diagnostic came through `JSON.stringify`.
 */
const AUTHORIZATION_HEADER_PATTERN =
  /((?:\\?["'])?authorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^"',}\r\n]*/gi;

/** Standalone bearer/basic schemes (stray header values, URLs, messages). */
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;

/** JSON / query-string credential fields (quote/backslash-escape tolerant). */
const SECRET_FIELD_PATTERN =
  /((?:\\?["'])?(?:access_token|refresh_token|client_secret|credentials|api[_-]?key|password|token)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^"',}\r\n]*/gi;

/**
 * Mask credentials, tokens and inline file payloads in an arbitrary string.
 * Safe to call on any diagnostic text; returns the input unchanged when empty.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(DATA_URL_PATTERN, `data:$1;base64,${REDACTED}`)
    .replace(AUTHORIZATION_HEADER_PATTERN, `$1${REDACTED}`)
    .replace(AUTH_SCHEME_PATTERN, `$1 ${REDACTED}`)
    .replace(SECRET_FIELD_PATTERN, `$1${REDACTED}`);
}
