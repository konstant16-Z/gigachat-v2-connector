# Security Audit — plan §31

Date: 2026-09-17
Scope: `src/**` (V1 translation path in `src/v2/**` + the V2 mapping pipeline in
`src/{core,gigachat,translation,streaming,types}/**`).
Method: static review of every network call, log call site, header handler,
error surface and request-controlled value, plus targeted regression tests
(`tests/unit/security.test.ts`, 12 tests).

All four gates stay green: `npx tsc --noEmit`, `bun test` (283 tests),
`npx biome check .`, `bun run build`.

---

## 1. Checklist verdicts

| # | Area | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Credentials | OK | `GIGACHAT_CREDENTIALS` / plugin `options.credentials` are held only in `authManager.credentialsValue` (`src/v2/auth.ts`) and sent **only** as `Authorization: Basic` to the fixed OAuth URL `ngw.devices.sberbank.ru:9443` (`GIGACHAT_OAUTH_URL`). Never logged; masked by `redactSecrets`. |
| 2 | Tokens | **Fixed** | Access tokens are cached in `tokenCache` and refreshed through `refreshPromise` (deduped). They are now attached **only** when the resolved target host is on the GigaChat allowlist (`isKnownGigaHost`, `src/v2/plugin.ts`). Never logged; masked by `redactSecrets`. |
| 3 | Logs | **Fixed** | `log` is debug-gated (`GIGACHAT_DEBUG`/`OPENCODE_DEBUG`); `warn`/`error` are intentional. All three now run message + stringified metadata through `redactSecrets` (`src/core/redact.ts` → `src/v2/constants.ts`). No full prompt/response is logged; only URLs, statuses and controlled error messages. |
| 4 | Request bodies | OK | The full outbound chat body is snapshotted in the in-memory `pendingRequests` map for retry (§19) and deleted in the response hook (§29). It is never logged. |
| 5 | File contents | **Fixed** | Data URLs are uploaded to the fixed `GIGACHAT_FILES_URL`; the full payload is masked anywhere it could appear in a diagnostic (data-URL redaction). Uploads are size-capped (see #11). |
| 6 | Headers | OK | Outbound `Authorization` is set explicitly. The direct-proxy branch strips the inbound `authorization` and `x-opencode-provider-marker` before adding the GigaChat token. Headers are never logged. |
| 7 | Errors | **Fixed** | `sanitizeError` (`src/v2/net.ts`) now redacts message + stack. `classifyUpstreamError` preserves only `{status, providerCode, requestId, retryable}` — no headers/body. |
| 8 | SSRF | **Fixed** | The only network targets are fixed constants (OAuth, Files) and the request-hook target; the hook now refuses to attach credentials unless the resolved host is allowlisted. Custom endpoints must be registered via the plugin `baseURL` option. |
| 9 | File paths | OK | No request-controlled filesystem paths. Only `DEFAULT_CA_BUNDLE_FILE` (fixed) and the admin-supplied `caBundlePath` are read via `fs`. |
| 10 | Malformed URLs | **Fixed** | `tryHost`/`registerGigaEndpoint` already fail safe; the request hook no longer calls `new URL(requestUrl)` unguarded (a malformed URL now degrades to "skip", not to a thrown error). |
| 11 | Oversized uploads | **Fixed** | `src/core/attachments.ts` enforces the documented per-attachment limits (image 15 MB, audio 35 MB, text 40 MB; `docs/external/gigachat-api.yml`) **before decoding**, in both upload paths (`src/v2/files.ts`, `src/v2/translator.ts`). |
| 12 | Malformed JSON Schema | OK | `toCustomFunction` (`src/gigachat/v2/tools/function.ts`) refuses a missing/non-object/array `parameters` with a controlled error instead of guessing. |
| 13 | Tool-name injection | OK | `validateFunctionName` (`src/gigachat/v2/tools/normalize.ts`) rejects empty, non-Latin, whitespace/control-character and leading-digit names; unsafe names are aliased through a **session-scoped** `ToolNameRegistry` rather than forwarded verbatim. |

---

## 2. Never log (invariant)

`src/core/redact.ts` masks, and `log`/`warn`/`error`/`sanitizeError` apply it to
every diagnostic string:

- `Authorization` header values (whole value, any scheme);
- bare `Bearer`/`Basic` values;
- `access_token`, `refresh_token`, `client_secret`, `credentials`, `api_key`,
  `password`, `token` fields (JSON or query style, including escaped quotes);
- inline `data:…;base64,…` payloads (a full uploaded file);
- full prompt/response: never logged at all — `log` is debug-gated and only
  emits URLs/statuses, never bodies.

---

## 3. Fixes delivered

1. **Credential-exfiltration / SSRF guard** (`src/v2/plugin.ts`,
   `src/v2/hosts.ts`). `isGigaProvider` matches broad substrings
   (`gigachat`, `gigacode`, `sberbank`, …), so a provider id alone could match
   while the request URL pointed at an arbitrary host; the token was then
   attached to that host. The request hook now resolves the effective target
   first and returns early unless `isKnownGigaHost(targetHost)` holds. The
   response hook applies the same host allowlist so a response from an unknown
   host is never misread as GigaChat wire.
2. **Secret redaction** (`src/core/redact.ts`, `src/v2/constants.ts`,
   `src/v2/net.ts`). Defense in depth for logs and propagated errors.
3. **Upload size caps** (`src/core/attachments.ts`, `src/v2/files.ts`,
   `src/v2/translator.ts`). Local, pre-decode rejection of oversized
   attachments.
4. **Malformed-URL handling** (`src/v2/plugin.ts`). Path classification no
   longer throws on an unparseable URL.

## 4. Accepted residual risks

- `isGigaProvider` remains intentionally broad. It is now only a *candidate*
  selector; credentials are gated by the host allowlist, so breadth is no
  longer a secret-leak vector.
- The full prompt lives in memory in `pendingRequests` for retry. This is
  required for the §19 retry contract; entries are RqUID-keyed and removed on
  response (§29). Process memory is trusted.
- Custom GigaChat-compatible endpoints must be registered (plugin `baseURL`);
  unregistered hosts are skipped rather than credentialed.
