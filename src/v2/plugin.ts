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
import { gigaHosts, registerGigaEndpoint, isGigaProvider, tryHost, targetUrlFor } from "./hosts.js";

const PLUGIN_ID = "gigacode";

type Options = {
  baseURL?: string;
  credentials?: string;
  scope?: string;
  verifySsl?: boolean;
  verifySSL?: boolean;
  caBundle?: string;
  caBundlePath?: string;
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

export const plugin = {
  id: PLUGIN_ID,
  async setup(ctx: IntegrationContext) {
    const options = optionsShape(ctx.options);
    log("GigaCodeConnectorPlugin (V2) setup executing...");
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
        const isGiga = (host && gigaHosts.has(host)) || isGigaProvider(modelProvider);
        if (!isGiga) return;

        log(`Intercepting ${event.request.method} request to: ${requestUrl}`);
        const { token } = await authManager.getAccessToken();
        const verifySsl = authManager.getVerifySsl();
        const caBundle = authManager.getCaBundle();
        const url = new URL(requestUrl);
        const isChat = url.pathname.includes("/chat/completions");
        const isFiles = url.pathname.includes("/files");
        const targetUrl = targetUrlFor(requestUrl, isChat, isFiles);
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
          const gigaBody = await translateOpenAiToGigaChat(openAiBody, token, verifySsl, caBundle);
          log("Forwarding translated request to GigaChat API completions...");
          const headers = new Headers({
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            RqUID: v4()
          });
          event.request = new Request(targetUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(gigaBody)
          });
        } else {
          log("Direct proxying GigaChat API call...");
          const headers = new Headers(event.request.headers);
          headers.delete("authorization");
          headers.delete("x-opencode-provider-marker");
          headers.set("Accept", "application/json");
          headers.set("Authorization", `Bearer ${token}`);
          headers.set("RqUID", v4());
          event.request = new Request(targetUrl, {
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
        const modelProvider = event?.model?.providerID;
        const isGiga = (host && gigaHosts.has(host)) || isGigaProvider(modelProvider);
        if (!isGiga || !event.response) return;
        const contentType = event.response.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) {
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