/**
 * Unit tests: plan §31 security audit.
 *
 * Covers the hardening added by the audit:
 *  - secret redaction in diagnostics (`redactSecrets`, `log`/`warn`/`error`,
 *    `sanitizeError`);
 *  - the plugin credential/SSRF guard (the GigaChat token is only ever sent to
 *    a known GigaChat host, never on a provider-id match alone);
 *  - attachment size limits (oversized uploads fail locally, before decoding).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertUploadSize,
  base64DecodedBytes,
  MAX_IMAGE_BYTES,
  maxUploadBytes,
} from "../../src/core/attachments";
import { redactSecrets } from "../../src/core/redact";
import { authManager } from "../../src/v2/auth";
import { error as logError } from "../../src/v2/constants";
import { sanitizeError } from "../../src/v2/net";
import { pendingRequestCount, plugin } from "../../src/v2/plugin";

const noop = (): void => {};

// ─── secret redaction ───────────────────────────────────────────────────────

describe("redactSecrets (plan §31 — never log credentials)", () => {
  test("masks Authorization bearer/basic header values", () => {
    const out = redactSecrets(
      "Authorization: Bearer sk-live-abc123\nAuthorization: Basic dXNlcjpwYXNz",
    );
    expect(out).not.toContain("sk-live-abc123");
    expect(out).not.toContain("dXNlcjpwYXNz");
  });

  test("masks JSON credential fields", () => {
    const out = redactSecrets(
      '{"access_token":"tok-1","client_secret":"sec-2","credentials":"Y3JlZHM="}',
    );
    expect(out).not.toContain("tok-1");
    expect(out).not.toContain("sec-2");
    expect(out).not.toContain("Y3JlZHM=");
  });

  test("masks inline base64 data URLs (full uploaded file)", () => {
    const payload = "A".repeat(256);
    const out = redactSecrets(`upload data:image/png;base64,${payload}`);
    expect(out).not.toContain(payload);
    expect(out).toContain("data:image/png;base64,***");
  });

  test("leaves benign diagnostic text untouched", () => {
    expect(redactSecrets("total_tokens: 123, model: GigaChat-2-Max")).toBe(
      "total_tokens: 123, model: GigaChat-2-Max",
    );
  });
});

describe("log/error helpers redact secrets (plan §31)", () => {
  test("error() masks credentials before printing", () => {
    const captured: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      logError("token leak:", '{"access_token":"tok-123"}');
    } finally {
      console.error = original;
    }
    const out = captured.join("\n");
    expect(out).not.toContain("tok-123");
    expect(out).toContain("***");
  });
});

describe("sanitizeError redaction (plan §31)", () => {
  test("redacts secrets from the message and the stack", () => {
    const err = new Error("request failed with header Authorization: Bearer sk-secret-42");
    const clean = sanitizeError(err);
    expect(clean.message).not.toContain("sk-secret-42");
    expect(clean.stack ?? "").not.toContain("sk-secret-42");
  });

  test("redacts credentials embedded in a non-Error throw", () => {
    const clean = sanitizeError("token=secret-xyz");
    expect(clean.message).not.toContain("secret-xyz");
  });
});

// ─── plugin credential / SSRF guard ─────────────────────────────────────────

/** Structural stand-in for the plugin's http.request / http.response events. */
interface TestEvent {
  request: {
    url: string;
    method: string;
    headers: { get: (key: string) => string | null };
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
  response?: Response;
  model?: { providerID?: string };
}

/**
 * Minimal fake plugin context capturing the registered hook handlers.
 * Structural stand-in for the plugin's (non-exported) IntegrationContext.
 */
interface TestPluginContext {
  options?: unknown;
  integration?: {
    transform?: (fn: (editor: unknown) => void) => Promise<unknown>;
  };
  session: {
    hook: (event: string, handler: (event: unknown) => Promise<void>) => Promise<unknown>;
  };
  tool: {
    hook: (event: string, handler: (event: unknown) => Promise<void>) => Promise<unknown>;
  };
}

function fakeCtx(options: unknown): {
  ctx: TestPluginContext;
  hooks: Record<string, (event: TestEvent) => Promise<void>>;
} {
  const hooks: Record<string, (event: TestEvent) => Promise<void>> = {};
  const ctx: TestPluginContext = {
    options,
    integration: {
      transform: async (fn: (editor: unknown) => void) => {
        fn({ update: noop, method: { update: noop } });
      },
    },
    session: {
      hook: async (name: string, handler: (event: unknown) => Promise<void>) => {
        hooks[name] = handler as (event: TestEvent) => Promise<void>;
      },
    },
    tool: {
      hook: async () => {},
    },
  };
  return { ctx, hooks };
}

describe("plugin http.request credential guard (plan §31 — SSRF)", () => {
  const origGetAccessToken = authManager.getAccessToken;
  const origGetVerifySsl = authManager.getVerifySsl;
  const origGetCaBundle = authManager.getCaBundle;
  const origBlockActiveAccount = authManager.blockActiveAccount;

  beforeEach(() => {
    authManager.getVerifySsl = () => true;
    authManager.getCaBundle = () => "";
    authManager.blockActiveAccount = () => {};
  });

  afterEach(() => {
    authManager.getAccessToken = origGetAccessToken;
    authManager.getVerifySsl = origGetVerifySsl;
    authManager.getCaBundle = origGetCaBundle;
    authManager.blockActiveAccount = origBlockActiveAccount;
  });

  /** Replace the token exchange with an offline stub; returns a call counter. */
  function stubToken(): () => number {
    let calls = 0;
    authManager.getAccessToken = async () => {
      calls += 1;
      return {
        token: "SECRET-TOKEN",
        account: { id: "t", name: "Test", credentials: "t", scope: "GIGACHAT_API_PERS" },
      };
    };
    return () => calls;
  }

  test("refuses to attach the token to an unknown host even when providerID matches", async () => {
    const called = stubToken();
    const { ctx, hooks } = fakeCtx({ v2: false });
    await plugin.setup(ctx);

    const event: TestEvent = {
      request: {
        url: "https://evil.example/v1/chat/completions",
        method: "POST",
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      },
      // `isGigaProvider` matches this id by substring, but the host is unknown.
      model: { providerID: "not-gigachat" },
    };
    await hooks["http.request"](event);

    expect(called()).toBe(0);
    expect(event.request.url).toBe("https://evil.example/v1/chat/completions");
    expect(event.request.headers.get("Authorization")).toBeNull();
  });

  test("still attaches the token to a known GigaChat host", async () => {
    const called = stubToken();
    const { ctx, hooks } = fakeCtx({ v2: false });
    await plugin.setup(ctx);

    const body = JSON.stringify({
      model: "GigaChat-2-Max",
      messages: [{ role: "user", content: "hi" }],
    });
    const event: TestEvent = {
      request: {
        url: "https://api.giga.chat/v1/chat/completions",
        method: "POST",
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
      },
      model: { providerID: "gigachat" },
    };
    await hooks["http.request"](event);

    expect(called()).toBe(1);
    expect(event.request.url).toBe("https://api.giga.chat/v1/chat/completions");
    expect(event.request.headers.get("Authorization")).toBe("Bearer SECRET-TOKEN");
    expect(pendingRequestCount()).toBe(1);

    // Clean up the retry snapshot so other suites see an empty pending map.
    await hooks["http.response"]({
      request: event.request,
      response: new Response(
        JSON.stringify({
          id: "cmpl-s",
          object: "chat.completion",
          created: 0,
          model: "GigaChat",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      model: { providerID: "gigachat" },
    });
    expect(pendingRequestCount()).toBe(0);
  });
});

// ─── attachment size limits ─────────────────────────────────────────────────

describe("attachment size limits (plan §31 — oversized uploads)", () => {
  test("computes decoded size without allocating the buffer", () => {
    expect(base64DecodedBytes("")).toBe(0);
    expect(base64DecodedBytes("TQ==")).toBe(1);
    expect(base64DecodedBytes("TWE=")).toBe(2);
    expect(base64DecodedBytes("TWFu")).toBe(3);
  });

  test("uses the documented per-mime limits", () => {
    expect(maxUploadBytes("image/png")).toBe(MAX_IMAGE_BYTES);
    expect(maxUploadBytes("audio/mpeg")).toBe(35 * 1024 * 1024);
    expect(maxUploadBytes("application/pdf")).toBe(40 * 1024 * 1024);
  });

  test("accepts a payload at the limit and rejects one above it", () => {
    expect(() => assertUploadSize("image/png", MAX_IMAGE_BYTES)).not.toThrow();
    expect(() => assertUploadSize("image/png", MAX_IMAGE_BYTES + 1)).toThrow(
      /attachment too large/,
    );
  });
});
