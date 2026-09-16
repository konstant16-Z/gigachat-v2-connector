/**
 * Unit tests: cancellation, stream abort and consistent session state (plan §29).
 *
 * Verifies:
 *  - sleep clears its timer promptly on abort (no leaked timers);
 *  - V1 translateStreamingResponse cancel propagates upstream (no open stream);
 *  - V2 streamingResponse cancel propagates upstream (no open stream);
 *  - pendingRequests map is cleaned up after every response (consistent session
 *    state — fix for the non-retryable-status memory leak).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createV2Pipeline } from "../../src/translation/v2-pipeline";
import { authManager } from "../../src/v2/auth";
import { pendingRequestCount, plugin } from "../../src/v2/plugin";
import { translateStreamingResponse } from "../../src/v2/response";
import { sleep } from "../../src/v2/retry";

const noop = (): void => {};

/** Readable reader for a streaming response body; null bodies are a test bug. */
function bodyReader(response: Response) {
  const body = response.body;
  if (body === null) {
    throw new Error("expected a streaming response body");
  }
  return body.getReader();
}

/** Minimal V1 SSE data-line that translateStreamChunk can process. */
const sseFrameBytes = new TextEncoder().encode(
  'data: {"id":"1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
);

/**
 * Build a canonical V2 SSE byte payload using the live-confirmed envelope
 * structure (response.message.delta + response.message.done).
 */
function v2FrameBytes(): Uint8Array {
  const encoder = new TextEncoder();
  const delta = JSON.stringify({
    messages: [{ role: "assistant", content: [{ text: "hi" }] }],
  });
  const done = JSON.stringify({
    finish_reason: "stop",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  });
  return encoder.encode(
    `event: response.message.delta\ndata: ${delta}\n\nevent: response.message.done\ndata: ${done}\n\n`,
  );
}

// ─── sleep / timer cleanup ──────────────────────────────────────────────────

describe("sleep timer hygiene (plan §29 — no leaked timers)", () => {
  test("aborted sleep rejects within a short window proving clearTimeout runs", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const promise = sleep(10_000, ac.signal);
    ac.abort();
    await expect(promise).rejects.toThrow("aborted");
    expect(Date.now() - t0).toBeLessThan(100);
  });

  test("many large sleeps abort cleanly without leaking timers", async () => {
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const t0 = Date.now();
    const promises = controllers.map(({ signal }) => sleep(60_000, signal));
    controllers.forEach((ac) => {
      ac.abort();
    });
    await Promise.allSettled(promises);
    // All 20 rejections complete well within one second
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

// ─── V1 stream cancel ───────────────────────────────────────────────────────

describe("V1 translateStreamingResponse cancel propagation (plan §29 — stream abort)", () => {
  test("cancelling translated stream cancels upstream reader (no open stream)", async () => {
    let upstreamCancels = 0;
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrameBytes);
        // Keep the stream open so we can observe the cancel mid-stream
      },
      cancel() {
        upstreamCancels += 1;
      },
    });

    const out = await translateStreamingResponse(new Response(raw));
    const reader = bodyReader(out);
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toBeDefined();

    await reader.cancel("client-abort");
    expect(upstreamCancels).toBe(1);
  });

  test("normal drain does not fire the cancel callback", async () => {
    const encoder = new TextEncoder();
    let upstreamCancels = 0;
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrameBytes);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() {
        upstreamCancels += 1;
      },
    });

    const out = await translateStreamingResponse(new Response(raw));
    const reader = bodyReader(out);
    while (!(await reader.read()).done) {
      // drain
    }
    expect(upstreamCancels).toBe(0);
  });
});

// ─── V2 stream cancel ───────────────────────────────────────────────────────

describe("V2 streamingResponse cancel propagation (plan §29 — stream abort)", () => {
  test("cancelling the piped V2 stream propagates cancellation to upstream body", async () => {
    let upstreamCancels = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(v2FrameBytes());
        // Keep open
      },
      cancel() {
        upstreamCancels += 1;
      },
    });

    const pipeline = createV2Pipeline({ onSseError: noop });
    const out = pipeline.streamingResponse(new Response(source), "cancel-test");
    const reader = bodyReader(out);
    const first = await reader.read();
    expect(first.done).toBe(false);

    await reader.cancel("client-abort");
    expect(upstreamCancels).toBe(1);
  });

  test("normal V2 drain does not fire the cancel callback", async () => {
    let upstreamCancels = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(v2FrameBytes());
        controller.close();
      },
      cancel() {
        upstreamCancels += 1;
      },
    });

    const pipeline = createV2Pipeline({ onSseError: noop });
    const out = pipeline.streamingResponse(new Response(source), "drain-test");
    const reader = bodyReader(out);
    while (!(await reader.read()).done) {
      // drain
    }
    expect(upstreamCancels).toBe(0);
  });
});

// ─── pendingRequests cleanup ────────────────────────────────────────────────

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

describe("pendingRequests cleanup (plan §29 — consistent session state)", () => {
  const origGetAccessToken = authManager.getAccessToken;
  const origGetVerifySsl = authManager.getVerifySsl;
  const origGetCaBundle = authManager.getCaBundle;
  const origBlockActiveAccount = authManager.blockActiveAccount;

  beforeEach(() => {
    authManager.getAccessToken = async () => ({
      token: "test-token",
      account: { id: "test", name: "Test", credentials: "test", scope: "GIGACHAT_API_PERS" },
    });
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

  function fakeCtx(): {
    ctx: TestPluginContext;
    hooks: Record<string, (event: TestEvent) => Promise<void>>;
  } {
    const hooks: Record<string, (event: TestEvent) => Promise<void>> = {};
    const ctx: TestPluginContext = {
      options: { v2: true, credentials: "dGVzdDpiYXNlNjQ=", baseURL: "https://api.giga.chat" },
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

  async function registerChatRequest(
    hooks: Record<string, (event: TestEvent) => Promise<void>>,
  ): Promise<TestEvent> {
    const url = "https://api.giga.chat/v2/chat/completions";
    const body = JSON.stringify({
      model: "GigaChat-2-Max",
      messages: [{ role: "user", content: "hi" }],
    });
    const reqEvent: TestEvent = {
      request: {
        url,
        method: "POST",
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
      },
      model: { providerID: "gigachat" },
    };
    await hooks["http.request"](reqEvent);
    return reqEvent;
  }

  test("pendingRequests cleaned up after a non-retryable response (the former leak)", async () => {
    const { ctx, hooks } = fakeCtx();
    await plugin.setup(ctx);
    try {
      expect(pendingRequestCount()).toBe(0);

      const reqEvent = await registerChatRequest(hooks);
      expect(pendingRequestCount()).toBe(1);
      expect(reqEvent.request.headers.get("RqUID")).toBeTruthy();

      // 422 — non-retryable: previously the entry leaked; now must be removed
      const upstream = new Response(JSON.stringify({ message: "Unprocessable" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
      await hooks["http.response"]({
        request: reqEvent.request,
        response: upstream,
        model: { providerID: "gigachat" },
      });

      expect(pendingRequestCount()).toBe(0);
    } finally {
      // no-op; afterEach restores the authManager
    }
  });

  test("pendingRequests cleaned up after a successful 200 response", async () => {
    const { ctx, hooks } = fakeCtx();
    await plugin.setup(ctx);
    expect(pendingRequestCount()).toBe(0);

    const reqEvent = await registerChatRequest(hooks);
    expect(pendingRequestCount()).toBe(1);

    const payload = JSON.stringify({
      id: "cmpl-test",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const upstream = new Response(payload, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await hooks["http.response"]({
      request: reqEvent.request,
      response: upstream,
      model: { providerID: "gigachat" },
    });

    expect(pendingRequestCount()).toBe(0);
  });

  test("response hook with no matching pending request passes through cleanly", async () => {
    const { ctx, hooks } = fakeCtx();
    await plugin.setup(ctx);
    expect(pendingRequestCount()).toBe(0);

    const upstream = new Response(JSON.stringify({ error: { message: "not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    // No prior request hook call → no pending entry; the hook must not crash
    await hooks["http.response"]({
      request: {
        url: "https://api.giga.chat/v2/chat/completions",
        method: "POST",
        headers: { get: () => "" },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      },
      response: upstream,
      model: { providerID: "gigachat" },
    });
    expect(pendingRequestCount()).toBe(0);
  });
});
