/**
 * Unit tests: structured observability (plan §32).
 *
 * Verifies:
 *  - normalized error categories for statuses, aborts, timeouts, network codes;
 *  - endpoint extraction that never echoes a malformed/credential-bearing URL;
 *  - the canonical one-line format and the `GIGACHAT_OBSERVABILITY` kill-switch;
 *  - credential redaction even if a secret reaches a metadata field;
 *  - per-request latency/retry snapshot with single-fire completion;
 *  - stream-end hooks on both V1 and V2 streams (completed vs cancelled);
 *  - plugin wiring: one OBS line per request with endpoint/model/status, never
 *    request/response content, and no registry leak.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  emitObservation,
  endpointOf,
  errorLike,
  formatObservation,
  normalizeErrorCategory,
  OBS_PREFIX,
  observabilityEnabled,
  RequestObservation,
} from "../../src/core/observability";
import { createV2Pipeline } from "../../src/translation/v2-pipeline";
import { authManager } from "../../src/v2/auth";
import { pendingObservationCount, plugin } from "../../src/v2/plugin";
import { translateStreamingResponse } from "../../src/v2/response";
import { specStateV2Response } from "../fixtures/responses/v2";

const noop = (): void => {};

// ─── normalizeErrorCategory ─────────────────────────────────────────────────

describe("normalizeErrorCategory (plan §32 — normalized error category)", () => {
  test("maps HTTP statuses to coarse categories", () => {
    expect(normalizeErrorCategory({ status: 401 })).toBe("auth");
    expect(normalizeErrorCategory({ status: 403 })).toBe("auth");
    expect(normalizeErrorCategory({ status: 429 })).toBe("rate_limit");
    expect(normalizeErrorCategory({ status: 408 })).toBe("timeout");
    expect(normalizeErrorCategory({ status: 504 })).toBe("timeout");
    expect(normalizeErrorCategory({ status: 400 })).toBe("client_error");
    expect(normalizeErrorCategory({ status: 422 })).toBe("client_error");
    expect(normalizeErrorCategory({ status: 500 })).toBe("server_error");
    expect(normalizeErrorCategory({ status: 503 })).toBe("server_error");
  });

  test("detects cancellation and timeout by name/message/code", () => {
    expect(normalizeErrorCategory({ name: "AbortError" })).toBe("cancelled");
    expect(normalizeErrorCategory({ message: "The operation was aborted" })).toBe("cancelled");
    expect(normalizeErrorCategory({ message: "request cancelled by client" })).toBe("cancelled");
    expect(normalizeErrorCategory({ name: "TimeoutError" })).toBe("timeout");
    expect(normalizeErrorCategory({ code: "ECONNABORTED" })).toBe("timeout");
    expect(normalizeErrorCategory({ message: "socket timed out" })).toBe("timeout");
  });

  test("detects network, malformed and configuration failures", () => {
    expect(normalizeErrorCategory({ code: "ECONNREFUSED" })).toBe("network");
    expect(normalizeErrorCategory({ code: "ENOTFOUND" })).toBe("network");
    expect(normalizeErrorCategory({ message: "fetch failed" })).toBe("network");
    expect(normalizeErrorCategory({ message: "malformed tool arguments JSON" })).toBe("malformed");
    expect(normalizeErrorCategory({ message: "unsupported tool_choice" })).toBe("config");
    expect(normalizeErrorCategory({ message: "missing model" })).toBe("config");
  });

  test("degrades unknown/empty input to unknown", () => {
    expect(normalizeErrorCategory()).toBe("unknown");
    expect(normalizeErrorCategory(null)).toBe("unknown");
    expect(normalizeErrorCategory({})).toBe("unknown");
    expect(normalizeErrorCategory({ message: "boom" })).toBe("unknown");
  });
});

describe("errorLike coercion", () => {
  test("reads status/name/message/code off objects", () => {
    expect(errorLike({ status: 500, name: "N", message: "m", code: "C" })).toEqual({
      status: 500,
      name: "N",
      message: "m",
      code: "C",
    });
  });

  test("accepts strings and primitives without throwing", () => {
    expect(errorLike("nope")).toEqual({ message: "nope" });
    expect(errorLike(42)).toEqual({ message: undefined });
    expect(errorLike(null)).toEqual({ message: undefined });
  });
});

// ─── endpointOf ─────────────────────────────────────────────────────────────

describe("endpointOf (plan §32 — endpoint)", () => {
  test("returns only the pathname of a valid URL", () => {
    expect(endpointOf("https://api.giga.chat/v2/chat/completions?x=1")).toBe(
      "/v2/chat/completions",
    );
    expect(endpointOf("https://user:secret@api.giga.chat/v1/files")).toBe("/v1/files");
  });

  test("never echoes a malformed or empty URL", () => {
    expect(endpointOf("not a url")).toBe("?");
    expect(endpointOf("http://")).toBe("?");
    expect(endpointOf(undefined)).toBe("?");
    expect(endpointOf("")).toBe("?");
  });
});

// ─── format / emit ──────────────────────────────────────────────────────────

describe("formatObservation (plan §32 — safe fields only)", () => {
  test("renders every field in a stable order", () => {
    const line = formatObservation({
      requestId: "rq-1",
      endpoint: "/v2/chat/completions",
      model: "GigaChat-2-Max",
      latencyMs: 12.6,
      retryCount: 2,
      status: 200,
      stream: "completed",
      tool: "get_weather",
      callId: "call_1",
      errorCategory: "rate_limit",
    });
    expect(line).toBe(
      "[GigaCode] [OBS] request_id=rq-1 endpoint=/v2/chat/completions " +
        "model=GigaChat-2-Max latency_ms=13 retries=2 status=200 stream=completed " +
        "tool=get_weather call_id=call_1 error=rate_limit",
    );
  });

  test("omits undefined and empty fields", () => {
    const line = formatObservation({ requestId: "rq-2", endpoint: "/x", status: 200 });
    expect(line).toBe("[GigaCode] [OBS] request_id=rq-2 endpoint=/x status=200");
    expect(line).not.toContain("model=");
    expect(line).not.toContain("latency_ms=");
    expect(line).not.toContain("retries=");
  });

  test("an all-empty observation still carries the prefix", () => {
    expect(formatObservation({})).toBe(OBS_PREFIX);
  });
});

describe("emitObservation (plan §32 — default on, env kill-switch)", () => {
  const originalEnv = process.env.GIGACHAT_OBSERVABILITY;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GIGACHAT_OBSERVABILITY;
    else process.env.GIGACHAT_OBSERVABILITY = originalEnv;
  });

  function captureLog(fn: () => void): string[] {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      fn();
    } finally {
      console.log = original;
    }
    return lines;
  }

  test("is enabled by default and disabled by falsy values", () => {
    delete process.env.GIGACHAT_OBSERVABILITY;
    expect(observabilityEnabled()).toBe(true);
    process.env.GIGACHAT_OBSERVABILITY = "true";
    expect(observabilityEnabled()).toBe(true);
    for (const value of ["false", "0", "off", "no", "OFF", " False "]) {
      process.env.GIGACHAT_OBSERVABILITY = value;
      expect(observabilityEnabled()).toBe(false);
    }
  });

  test("emits exactly one line", () => {
    delete process.env.GIGACHAT_OBSERVABILITY;
    const lines = captureLog(() => {
      emitObservation({ requestId: "rq-3", endpoint: "/v2/chat/completions", status: 200 });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("request_id=rq-3");
  });

  test("does not emit when disabled", () => {
    process.env.GIGACHAT_OBSERVABILITY = "false";
    const lines = captureLog(() => {
      emitObservation({ requestId: "rq-4" });
    });
    expect(lines).toHaveLength(0);
  });

  test("redacts a credential that reaches a metadata field", () => {
    delete process.env.GIGACHAT_OBSERVABILITY;
    const lines = captureLog(() => {
      emitObservation({ endpoint: "/x", model: "access_token=super-secret-value" });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("super-secret-value");
    expect(lines[0]).toContain("access_token=***");
  });
});

// ─── RequestObservation ─────────────────────────────────────────────────────

describe("RequestObservation (plan §32 — latency/retry snapshot)", () => {
  test("computes latency from the injected clock and counts retries", () => {
    let now = 1000;
    const obs = new RequestObservation({
      requestId: "rq-5",
      endpoint: "/v2/chat/completions",
      model: "GigaChat-2-Max",
      now: () => now,
    });
    obs.retry();
    obs.retry();
    now = 1250;
    expect(obs.retryCount).toBe(2);
    expect(obs.snapshot({ status: 200 })).toEqual({
      requestId: "rq-5",
      endpoint: "/v2/chat/completions",
      model: "GigaChat-2-Max",
      latencyMs: 250,
      retryCount: 2,
      status: 200,
    });
  });

  test("omits model and retries when absent", () => {
    const obs = new RequestObservation({ requestId: "rq-6", endpoint: "/v1/files", now: () => 0 });
    const fields = obs.snapshot({ status: 201 });
    expect(fields.model).toBeUndefined();
    expect(fields.retryCount).toBeUndefined();
    expect(fields.latencyMs).toBe(0);
  });

  test("finish is single-fire (SSE end racing the fallback path)", () => {
    const obs = new RequestObservation({ requestId: "rq-7", endpoint: "/x", now: () => 5 });
    const first = obs.finish({ stream: "completed" });
    const second = obs.finish({ stream: "cancelled" });
    expect(first?.stream).toBe("completed");
    expect(second).toBeUndefined();
  });
});

// ─── stream-end hooks ───────────────────────────────────────────────────────

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

const v1FrameBytes = new TextEncoder().encode(
  'data: {"id":"1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
);

function readerOf(response: Response) {
  if (response.body === null) throw new Error("expected a streaming body");
  return response.body.getReader();
}

describe("V2 streamingResponse onEnd hook (plan §32 — stream completion)", () => {
  test("normal drain reports completed exactly once", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(v2FrameBytes());
        controller.close();
      },
    });
    const pipeline = createV2Pipeline({ onSseError: noop });
    const ends: Array<{ completed: boolean }> = [];
    const out = pipeline.streamingResponse(new Response(source), "obs-drain", {
      onEnd: (info) => ends.push(info),
    });
    const reader = readerOf(out);
    while (!(await reader.read()).done) {
      // drain
    }
    expect(ends).toEqual([{ completed: true }]);
  });

  test("client cancel reports cancelled", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(v2FrameBytes());
        // keep open
      },
    });
    const pipeline = createV2Pipeline({ onSseError: noop });
    const ends: Array<{ completed: boolean }> = [];
    const out = pipeline.streamingResponse(new Response(source), "obs-cancel", {
      onEnd: (info) => ends.push(info),
    });
    const reader = readerOf(out);
    await reader.read();
    await reader.cancel("client-abort");
    expect(ends).toEqual([{ completed: false }]);
  });

  test("a hook that throws cannot break the stream", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(v2FrameBytes());
        controller.close();
      },
    });
    const pipeline = createV2Pipeline({ onSseError: noop });
    const out = pipeline.streamingResponse(new Response(source), "obs-throw", {
      onEnd: () => {
        throw new Error("hook boom");
      },
    });
    const reader = readerOf(out);
    while (!(await reader.read()).done) {
      // drain
    }
  });
});

describe("V1 translateStreamingResponse onEnd hook (plan §32 — stream completion)", () => {
  test("normal drain reports completed; cancel reports cancelled", async () => {
    const completed: Array<{ completed: boolean }> = [];
    const drained = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(v1FrameBytes);
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const out = await translateStreamingResponse(new Response(drained), (info) =>
      completed.push(info),
    );
    const reader = readerOf(out);
    while (!(await reader.read()).done) {
      // drain
    }
    expect(completed).toEqual([{ completed: true }]);

    const cancelled: Array<{ completed: boolean }> = [];
    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(v1FrameBytes);
      },
    });
    const out2 = await translateStreamingResponse(new Response(open), (info) =>
      cancelled.push(info),
    );
    const reader2 = readerOf(out2);
    await reader2.read();
    await reader2.cancel("client-abort");
    expect(cancelled).toEqual([{ completed: false }]);
  });
});

// ─── plugin wiring ──────────────────────────────────────────────────────────

interface TestEvent {
  request: {
    url: string;
    method: string;
    headers: { get: (key: string) => string | null };
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
  response?: Response;
  model?: { providerID?: string };
  tool?: string;
  callID?: string;
}

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
  toolHooks: Record<string, (event: TestEvent) => Promise<void>>;
} {
  const hooks: Record<string, (event: TestEvent) => Promise<void>> = {};
  const toolHooks: Record<string, (event: TestEvent) => Promise<void>> = {};
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
      hook: async (name: string, handler: (event: unknown) => Promise<void>) => {
        toolHooks[name] = handler as (event: TestEvent) => Promise<void>;
      },
    },
  };
  return { ctx, hooks, toolHooks };
}

async function captureObs(fn: () => Promise<void> | void): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.filter((line) => line.startsWith(OBS_PREFIX));
}

function chatRequestBody(): string {
  return JSON.stringify({
    model: "GigaChat-2-Max",
    messages: [{ role: "user", content: "hi" }],
  });
}

async function registerChatRequest(
  hooks: Record<string, (event: TestEvent) => Promise<void>>,
  url = "https://api.giga.chat/v2/chat/completions",
): Promise<TestEvent> {
  const reqEvent: TestEvent = {
    request: {
      url,
      method: "POST",
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(chatRequestBody()).buffer),
    },
    model: { providerID: "gigachat" },
  };
  await hooks["http.request"](reqEvent);
  return reqEvent;
}

describe("plugin observability wiring (plan §32)", () => {
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

  test("V2 JSON completion emits one safe line and clears the registry", async () => {
    const { ctx, hooks } = fakeCtx();
    const cleanup = await plugin.setup(ctx);
    try {
      const reqEvent = await registerChatRequest(hooks);
      expect(pendingObservationCount()).toBe(1);

      const upstream = new Response(JSON.stringify(specStateV2Response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const lines = await captureObs(async () => {
        await hooks["http.response"]({ request: reqEvent.request, response: upstream });
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("endpoint=/v2/chat/completions");
      expect(lines[0]).toContain("model=GigaChat-2-Max");
      expect(lines[0]).toContain("status=200");
      expect(lines[0]).toMatch(/latency_ms=\d+/);
      expect(lines[0]).not.toContain("test-token");
      expect(lines[0]).not.toContain("messages");
      expect(pendingObservationCount()).toBe(0);
    } finally {
      cleanup?.();
    }
  });

  test("V2 streaming completion emits on stream end with stream=completed", async () => {
    const { ctx, hooks } = fakeCtx();
    const cleanup = await plugin.setup(ctx);
    try {
      const reqEvent = await registerChatRequest(hooks);
      const upstream = new Response(v2FrameBytes(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      const responseEvent: TestEvent = { request: reqEvent.request, response: upstream };

      const lines = await captureObs(async () => {
        await hooks["http.response"](responseEvent);
        const body = responseEvent.response?.body;
        if (body === null || body === undefined) throw new Error("no translated body");
        const reader = body.getReader();
        while (!(await reader.read()).done) {
          // drain
        }
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("stream=completed");
      expect(lines[0]).toContain("endpoint=/v2/chat/completions");
      expect(pendingObservationCount()).toBe(0);
    } finally {
      cleanup?.();
    }
  });

  test("cancelled V2 stream emits stream=cancelled", async () => {
    const { ctx, hooks } = fakeCtx();
    const cleanup = await plugin.setup(ctx);
    try {
      const reqEvent = await registerChatRequest(hooks);
      // Keep the upstream open so the translated stream cannot flush before we
      // cancel it (otherwise the completion path would win the race).
      const openUpstream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(v2FrameBytes());
        },
      });
      const upstream = new Response(openUpstream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      const responseEvent: TestEvent = { request: reqEvent.request, response: upstream };

      const lines = await captureObs(async () => {
        await hooks["http.response"](responseEvent);
        const body = responseEvent.response?.body;
        if (body === null || body === undefined) throw new Error("no translated body");
        const reader = body.getReader();
        await reader.read();
        await reader.cancel("client-abort");
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("stream=cancelled");
      expect(pendingObservationCount()).toBe(0);
    } finally {
      cleanup?.();
    }
  });

  test("unknown host is never observed", async () => {
    const { ctx, hooks } = fakeCtx();
    const cleanup = await plugin.setup(ctx);
    try {
      const lines = await captureObs(async () => {
        await hooks["http.request"]({
          request: {
            url: "https://example.com/v1/chat/completions",
            method: "POST",
            headers: { get: () => null },
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          },
          model: { providerID: "gigachat" },
        });
      });
      expect(lines).toHaveLength(0);
      expect(pendingObservationCount()).toBe(0);
    } finally {
      cleanup?.();
    }
  });

  test("tool.execute.before emits the tool name", async () => {
    const { ctx, toolHooks } = fakeCtx();
    const cleanup = await plugin.setup(ctx);
    try {
      const lines = await captureObs(async () => {
        await toolHooks["execute.before"]({
          request: {
            url: "",
            method: "",
            headers: { get: () => null },
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          },
          tool: "get_weather",
          callID: "call_1",
        });
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("tool=get_weather");
      expect(lines[0]).toContain("call_id=call_1");
    } finally {
      cleanup?.();
    }
  });

  test("a request-hook failure reports an error category and does not leak", async () => {
    const { ctx, hooks } = fakeCtx();
    const cleanup = await plugin.setup(ctx);
    const orig = authManager.getAccessToken;
    authManager.getAccessToken = async () => {
      throw new Error("fetch failed: network down");
    };
    try {
      const lines = await captureObs(async () => {
        const reqEvent: TestEvent = {
          request: {
            url: "https://api.giga.chat/v2/chat/completions",
            method: "POST",
            headers: { get: () => null },
            arrayBuffer: () => Promise.resolve(new TextEncoder().encode(chatRequestBody()).buffer),
          },
          model: { providerID: "gigachat" },
        };
        await expect(hooks["http.request"](reqEvent)).rejects.toThrow();
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("error=network");
      expect(pendingObservationCount()).toBe(0);
    } finally {
      authManager.getAccessToken = orig;
      cleanup?.();
    }
  });
});
