/**
 * OpenCode V2 plugin: GigaCodeConnectorPlugin.
 *
 * Hooks:
 *  - http.request:  rewrite OpenAI-format requests to GigaChat (auth + body
 *                   translation), for chat/completions, files, and direct calls.
 *  - http.response: translate GigaChat JSON/SSE responses back to OpenAI format.
 *  - tool.execute.before: log tool executions (helps debugging the tool-call
 *                   pairing logic).
 */
import { v4 } from "uuid";
import { log, error, warn } from "./constants.js";
import { sanitizeError } from "./net.js";
import { authManager } from "./auth.js";
import { translateOpenAiToGigaChat } from "./translator.js";
import { translateJsonResponse, translateStreamingResponse } from "./response.js";
import { createV2Pipeline } from "../translation/v2-pipeline.js";
import type { V2Pipeline } from "../translation/v2-pipeline.js";
import { backoffDelayMs, loadRetryConfig, sleep } from "./retry.js";
import { isRetryableStatus } from "../gigachat/v2/errors.js";
import {
  registerGigaEndpoint,
  isGigaProvider,
  isKnownGigaHost,
  tryHost,
  targetUrlFor,
  targetV2UrlFor
} from "./hosts.js";

const PLUGIN_ID = "gigacode";

/** Final outbound request snapshot kept for retry (plan §19); chat only. */
interface PendingRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | Uint8Array;
}

/** Pending requests keyed by RqUID, consumed by the response hook. */
const pendingRequests = new Map<string, PendingRequest>();

type Options = {
  baseURL?: string;
  credentials?: string;
  scope?: string;
  verifySsl?: boolean;
  verifySSL?: boolean;
  caBundle?: string;
  caBundlePath?: string;
  /** Opt into the V2 mapping pipeline (plan §22) for chat completions. */
  v2?: boolean;
};

const optionsShape = (options: unknown): Options =>
  options && typeof options === "object" ? (options as Options) : {};

const GIGA_SCOPE_OPTIONS = [
  { value: "GIGACHAT_API_PERS", label: "Personal", description: "For individual developer accounts" },
  { value: "GIGACHAT_API_B2B", label: "B2B", description: "For B2B developer accounts" },
  { value: "GIGACHAT_API_CORP", label: "Corporate", description: "For corporate developer accounts" }
];

interface IntegrationContext {
  integration?: {
    list?: () => Promise<unknown[] | void>;
    connection?: {
      active?: (id: string) => Promise<unknown>;
      resolve?: (connection: unknown) => Promise<unknown>;
    };
    transform?: (fn: (editor: unknown) => void) => Promise<unknown>;
  };
  session: {
    hook: (event: string, handler: (event: any) => Promise<void>) => Promise<unknown>;
  };
  tool: {
    hook: (event: string, handler: (event: any) => Promise<void>) => Promise<unknown>;
  };
  options?: unknown;
}

/** Find an active GigaChat integration connection and resolve its API key. */
export async function resolveGigaConnection(ctx: IntegrationContext) {
  const candidates: string[] = [];
  const push = (id: string) => {
    if (id && !candidates.includes(id)) candidates.push(id);
  };
  push("gigachat");
  push("GigaChat (Sberbank)");
  try {
    const refs = await ctx.integration?.list?.();
    if (Array.isArray(refs)) {
      for (const ref of refs as Array<{ id?: string; name?: string }>) {
        if (ref?.id === "gigachat") push(ref.id);
        else if (ref?.name && /giga/i.test(String(ref.name)) && ref.id) push(ref.id);
      }
    }
  } catch {}
  for (const id of candidates) {
    try {
      const connection = await ctx.integration?.connection?.active?.(id);
      if (!connection) continue;
      const credential = await ctx.integration?.connection?.resolve?.(connection);
      const key =
        credential && typeof credential === "object" && "key" in credential
          ? (credential as { key?: unknown }).key
          : undefined;
      if (typeof key === "string" && key) return { connection, credential, key };
    } catch {}
  }
  return undefined;
}

/** Session key for the tool-state store (V2 plugin API: `event.sessionID`). */
const sessionKey = (event: any): string => {
  const id = event?.sessionID;
  return typeof id === "string" && id ? id : "default-session";
};

export const plugin = {
  id: PLUGIN_ID,
  async setup(ctx: IntegrationContext) {
    const options = optionsShape(ctx.options);
    const v2 = options.v2 === true;
    const pipeline: V2Pipeline | undefined = v2
      ? createV2Pipeline({ onSseError: (msg) => error("V2 SSE:", msg) })
      : undefined;
    log(`GigaCodeConnectorPlugin (V2) setup executing... (v2 pipeline: ${v2 ? "on" : "off"})`);
    if (typeof options.baseURL === "string" && options.baseURL) {
      registerGigaEndpoint(options.baseURL);
    }

    let credentials: string | undefined = options.credentials;
    if (!credentials && process.env.GIGACHAT_CREDENTIALS) {
      credentials = process.env.GIGACHAT_CREDENTIALS;
    }
    if (credentials) {
      const scope = options.scope || process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";
      const verifySsl = options.verifySsl ?? options.verifySSL;
      const caBundle = options.caBundle || options.caBundlePath;
      authManager.setCredentials(credentials, scope, verifySsl, caBundle);
      log("Credentials loaded from plugin options / environment.");
    }

    try {
      const resolved = await resolveGigaConnection(ctx);
      if (resolved) {
        const scope =
          (resolved.credential as any)?.configuration?.scope ??
          (resolved.connection as any)?.metadata?.scope ??
          undefined;
        authManager.setCredentials(resolved.key as string, scope);
        log("Credentials loaded from active integration connection.");
      }
    } catch (err) {
      log("Integration connection lookup skipped:", err instanceof Error ? err.message : String(err));
    }

    try {
      await ctx.integration?.transform?.((editor: any) => {
        editor.update?.("gigachat", (integration: any) => {
          integration.name = "GigaChat (Sberbank)";
        });
        editor.method?.update?.({
          integrationID: "gigachat",
          method: {
            id: "api-key",
            type: "key",
            label: "GigaChat API key",
            form: [
              {
                key: "scope",
                type: "string",
                title: "API Scope",
                description: "Type of GigaChat developer account",
                default: "GIGACHAT_API_PERS",
                options: GIGA_SCOPE_OPTIONS
              }
            ]
          }
        });
      });
      log("GigaChat integration methods registered.");
    } catch (err) {
      log("Integration registration skipped:", err instanceof Error ? err.message : String(err));
    }

    await ctx.session.hook("http.request", async (event: any) => {
      try {
        const requestUrl: string = event?.request?.url;
        const host = tryHost(requestUrl);
        const modelProvider = event?.model?.providerID;
        const isGiga = isKnownGigaHost(host) || isGigaProvider(modelProvider);
        if (!isGiga) return;

        // Path classification without throwing on malformed URLs (plan §31:
        // a malformed URL must degrade to "skip", never to a crash or a
        // credential leak).
        let pathname = "";
        try {
          pathname = new URL(requestUrl).pathname;
        } catch {
          pathname = "";
        }
        const isChat = pathname.includes("/chat/completions");
        const isFiles = pathname.includes("/files");

        // Resolve the effective target before fetching a token, then refuse to
        // send the GigaChat token anywhere that is not a known GigaChat host
        // (plan §31: SSRF / credential-exfiltration guard). `isGigaProvider`
        // deliberately matches broad substrings, so a provider id alone must
        // never be enough to attach `Authorization`.
        const resolvedTarget =
          isChat && v2 && pipeline
            ? targetV2UrlFor(requestUrl)
            : targetUrlFor(requestUrl, isChat, isFiles);
        const targetHost = tryHost(resolvedTarget);
        if (!isKnownGigaHost(targetHost)) {
          warn(
            `Refusing to intercept a request to unrecognised host "${
              targetHost ?? requestUrl
            }": GigaChat credentials are only sent to known GigaChat hosts ` +
              "(register a custom endpoint via the plugin `baseURL` option).",
          );
          return;
        }

        log(`Intercepting ${event.request.method} request to: ${resolvedTarget}`);
        const { token } = await authManager.getAccessToken();
        const verifySsl = authManager.getVerifySsl();
        const caBundle = authManager.getCaBundle();
        const rawBody = await event.request.arrayBuffer();

        if (isChat) {
          let openAiBody: any = {};
          if (rawBody.byteLength > 0) {
            try {
              openAiBody = JSON.parse(new TextDecoder().decode(rawBody));
            } catch (e) {
              warn("Failed to parse OpenAI request body, forwarding raw:", e);
            }
          }
          let gigaBody: unknown;
          const targetUrl = resolvedTarget;
          if (v2 && pipeline) {
            gigaBody = await pipeline.chatRequest(openAiBody, sessionKey(event));
            log("Forwarding V2-mapped request to GigaChat V2 completions...");
          } else {
            gigaBody = await translateOpenAiToGigaChat(openAiBody, token, verifySsl, caBundle);
            log("Forwarding translated request to GigaChat API completions...");
          }
          const headers = new Headers({
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            RqUID: v4()
          });
          const body = JSON.stringify(gigaBody);
          event.request = new Request(targetUrl, {
            method: "POST",
            headers,
            body
          });
          // Snapshot for retry (plan §19): chat completions are safe to retry
          // on transient errors; files/direct are not (non-idempotent).
          pendingRequests.set(headers.get("RqUID") ?? "", {
            url: targetUrl,
            method: "POST",
            headers,
            body
          });
        } else {
          log("Direct proxying GigaChat API call...");
          const headers = new Headers(event.request.headers);
          headers.delete("authorization");
          headers.delete("x-opencode-provider-marker");
          headers.set("Accept", "application/json");
          headers.set("Authorization", `Bearer ${token}`);
          headers.set("RqUID", v4());
          event.request = new Request(resolvedTarget, {
            method: event.request.method,
            headers,
            body: new Uint8Array(rawBody)
          });
        }
      } catch (err) {
        const cleanErr = sanitizeError(err);
        if (cleanErr.status === 429) {
          authManager.blockActiveAccount("HTTP 429 Rate Limited");
        } else if (cleanErr.status === 403) {
          authManager.blockActiveAccount("HTTP 403 Quota/Billing Exhausted");
        }
        error("Interception translation failed:", cleanErr.message);
        throw cleanErr;
      }
    });

    await ctx.session.hook("http.response", async (event: any) => {
      try {
        const requestUrl: string = event?.request?.url;
        const host = tryHost(requestUrl);
        // Only translate responses for known GigaChat hosts (plan §31). The
        // request hook never rewrites or stores anything for an unknown host,
        // so a provider-id-only match must not be treated as GigaChat wire.
        if (!isKnownGigaHost(host) || !event.response) return;

        // Retry/backoff (plan §19): 429/5xx → exponential backoff; 401 → token
        // refresh + one retry. Only for chat completions (idempotent); files/
        // direct calls pass through. Uses the snapshot registered in the
        // request hook, keyed by RqUID.
        const rquid = event?.request?.headers?.get?.("RqUID") ?? "";
        const stored = pendingRequests.get(rquid);
        if (stored && (isRetryableStatus(event.response.status) || event.response.status === 401)) {
          const retryConfig = loadRetryConfig();
          let current: Response = event.response;
          let refreshed = false;
          for (let attempt = 0; attempt < retryConfig.maxAttempts; attempt++) {
            const status = current.status;
            if (status === 401) {
              if (refreshed) break; // refresh exactly once; surface a second 401
              refreshed = true;
              authManager.clearTokenCache();
              const { token } = await authManager.getAccessToken();
              stored.headers.set("Authorization", `Bearer ${token}`);
              warn("Retrying request after token refresh (401).");
            } else if (!isRetryableStatus(status)) {
              break;
            } else {
              await sleep(backoffDelayMs(attempt, retryConfig));
            }
            try {
              const fetchOpts: RequestInit = {
                method: stored.method,
                headers: new Headers(stored.headers),
                body: stored.body
              };
              if (retryConfig.timeoutMs > 0) fetchOpts.signal = AbortSignal.timeout(retryConfig.timeoutMs);
              current = await fetch(new Request(stored.url, fetchOpts));
            } catch (fetchErr) {
              warn("Retry fetch failed:", fetchErr instanceof Error ? fetchErr.message : String(fetchErr));
              // Transient network failure counts against the retry budget too.
            }
            log(`Upstream ${String(current.status)} after attempt ${attempt + 1}/${retryConfig.maxAttempts}`);
          }
          event.response = current;
        }
        // Always clean up the pending-request snapshot once we've processed
        // the response (retryable or not) so the Map doesn't leak entries
        // for non-retryable statuses (200/400/422) — plan §29: consistent
        // session state after cancellation/response.
        if (stored) {
          pendingRequests.delete(rquid);
        }

        const contentType = event.response.headers.get("content-type") || "";
        if (v2 && pipeline) {
          const isChat = typeof requestUrl === "string" && requestUrl.includes("/chat/completions");
          if (!isChat) return; // files/direct calls pass through untouched in V2 mode
          event.response = contentType.includes("text/event-stream")
            ? pipeline.streamingResponse(event.response, sessionKey(event))
            : await pipeline.jsonResponseFromUpstream(event.response, sessionKey(event));
        } else if (contentType.includes("text/event-stream")) {
          event.response = await translateStreamingResponse(event.response);
        } else {
          event.response = await translateJsonResponse(event.response);
        }
      } catch (err) {
        error("Response translation failed:", err instanceof Error ? err.message : String(err));
        throw err;
      }
    });

    await ctx.tool.hook("execute.before", async (event: any) => {
      log(`Executing tool: ${event?.tool} (Call ID: ${event?.callID ?? ""})`);
    });

    log("GigaCodeConnectorPlugin (V2) loaded successfully.");
    return () => {
      log("GigaCodeConnectorPlugin (V2) unloaded.");
    };
  }
};

export default plugin;

/**
 * Diagnostic: number of pending request snapshots awaiting response translation.
 * Used in tests to verify plan §29 consistent-session-state cleanup.
 * Safe to call in production (returns a plain count).
 */
export function pendingRequestCount(): number {
  return pendingRequests.size;
}