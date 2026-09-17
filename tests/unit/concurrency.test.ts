/**
 * Unit tests: concurrency isolation (plan §30).
 *
 * Parallel requests (A, B, C) must not mix:
 *  - tool IDs / aliases (per-session ToolNameRegistry);
 *  - tools_state_id (per-session store — deep coverage lives in tools-state.test.ts);
 *  - response events (parallel SSE streams);
 *  - auth state (concurrent token refresh must be deduped);
 *  - request-local mutable data (pendingRequests snapshots keyed by RqUID).
 *
 * Covers the gaps left by §11 (store) and §23 (registries) unit tests:
 * integration-level isolation through the pipeline and the plugin hooks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NormalizedResponse } from "../../src/core/types";
import {
  aliasNamesInRequest,
  restoreNamesInResponse,
  ToolNameRegistry,
} from "../../src/gigachat/v2/tools/normalize";
import { createV2Pipeline } from "../../src/translation/v2-pipeline";
import { authManager, GigaCodeAuthManager } from "../../src/v2/auth";
import { pendingRequestCount, plugin } from "../../src/v2/plugin";
import { reasoningStream, textStream } from "../fixtures/streaming/sse";

const noop = (): void => {};

/** Readable reader for a streaming response body; null bodies are a test bug. */
function bodyReader(response: Response) {
  const body = response.body;
  if (body === null) {
    throw new Error("expected a streaming response body");
  }
  return body.getReader();
}

/** Read an entire response body and concat the text. */
async function collectText(response: Response): Promise<string> {
  const reader = bodyReader(response);
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A single-chunk closed byte stream from a text payload. */
function byteStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

// ─── per-session alias isolation ────────────────────────────────────────────

describe("per-session tool-name isolation under parallelism (plan §30)", () => {
  test("restoreNamesInResponse uses the session's own registry (colliding tool_1)", () => {
    const regA = new ToolNameRegistry();
    const regB = new ToolNameRegistry();
    regA.aliasFor("fn alpha");
    regB.aliasFor("fn beta");
    expect(regA.aliasFor("fn alpha")).toBe("tool_1");
    expect(regB.aliasFor("fn beta")).toBe("tool_1");

    const outA = restoreNamesInResponse(normalizedWithTool("tool_1"), regA);
    const outB = restoreNamesInResponse(normalizedWithTool("tool_1"), regB);
    expect(outA.choices[0].message.toolCalls?.[0].name).toBe("fn alpha");
    expect(outB.choices[0].message.toolCalls?.[0].name).toBe("fn beta");
  });

  test("aliasNamesInRequest aliases only through the given registry", () => {
    const regA = new ToolNameRegistry();
    const regB = new ToolNameRegistry();
    const named = normalizedRequestWithTool("fn gamma");
    const viaA = aliasNamesInRequest(named, regA);
    const viaB = aliasNamesInRequest(named, regB);
    // each registry aliases the same first unsafe name to its own tool_1
    expect(viaA.tools?.[0].name).toBe("tool_1");
    expect(viaB.tools?.[0].name).toBe("tool_1");
    expect(regA.originalOf("tool_1")).toBe("fn gamma");
    expect(regB.originalOf("tool_1")).toBe("fn gamma");
  });

  test("pipeline wires per-session registries end-to-end (chatRequest → streaming restore)", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    // Session A and B each alias a DIFFERENT unsafe name to tool_1
    await pipeline.chatRequest(chatBody("fn alpha"), "ses-A");
    await pipeline.chatRequest(chatBody("fn beta"), "ses-B");

    // A wire stream carrying tool_1 must restore per session
    const streamA = pipeline.streamingResponse(
      new Response(byteStream(aliasDoneStream("tool_1"))),
      "ses-A",
    );
    const textA = await collectText(streamA);
    expect(textA).toContain("fn alpha");
    expect(textA).not.toContain("fn beta");

    const streamB = pipeline.streamingResponse(
      new Response(byteStream(aliasDoneStream("tool_1"))),
      "ses-B",
    );
    const textB = await collectText(streamB);
    expect(textB).toContain("fn beta");
    expect(textB).not.toContain("fn alpha");
  });
});

// ─── parallel SSE streams ───────────────────────────────────────────────────

describe("parallel SSE streams do not mix response events (plan §30)", () => {
  test("interleaved streams for two sessions yield only their own content", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const outA = pipeline.streamingResponse(new Response(byteStream(textStream)), "ses-A");
    const outB = pipeline.streamingResponse(new Response(byteStream(reasoningStream)), "ses-B");

    // Interleave the reads: A1, B1, A2, B2, …
    const readerA = bodyReader(outA);
    const readerB = bodyReader(outB);
    const decoder = new TextDecoder();
    let textA = "";
    let textB = "";
    let doneA = false;
    let doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) {
        const { done, value } = await readerA.read();
        doneA = done;
        if (value) textA += decoder.decode(value);
      }
      if (!doneB) {
        const { done, value } = await readerB.read();
        doneB = done;
        if (value) textB += decoder.decode(value);
      }
    }

    expect(textA).toContain("Привет");
    expect(textA).toContain("мир!");
    expect(textA).not.toContain("Размышляю");
    expect(textA).not.toContain("Ответ: 42");

    expect(textB).toContain("Размышляю");
    expect(textB).toContain("Ответ: 42");
    expect(textB).not.toContain("Привет");
  });

  test("two parallel streams for the SAME session stay isolated", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const outA = pipeline.streamingResponse(new Response(byteStream(textStream)), "same-ses");
    const outB = pipeline.streamingResponse(new Response(byteStream(reasoningStream)), "same-ses");

    const readerA = bodyReader(outA);
    const readerB = bodyReader(outB);
    const decoder = new TextDecoder();
    let textA = "";
    let textB = "";
    let doneA = false;
    let doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) {
        const { done, value } = await readerA.read();
        doneA = done;
        if (value) textA += decoder.decode(value);
      }
      if (!doneB) {
        const { done, value } = await readerB.read();
        doneB = done;
        if (value) textB += decoder.decode(value);
      }
    }

    expect(textA).toContain("Привет");
    expect(textA).not.toContain("Размышляю");
    expect(textB).toContain("Размышляю");
    expect(textB).not.toContain("Привет");
  });
});

// ─── auth state ─────────────────────────────────────────────────────────────

describe("concurrent token refresh is deduplicated (plan §30 — auth state)", () => {
  test("N parallel getAccessToken calls share a single OAuth refresh", async () => {
    const instance = new GigaCodeAuthManager();
    instance.setCredentials("dGVzdDpiYXNlNjQ=", "GIGACHAT_API_PERS");
    let calls = 0;
    refresher(instance).fetchToken = async () => {
      calls += 1;
      // force overlap so all three are in-flight on the same refreshPromise
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "spy-access-token";
    };

    const results = await Promise.all([
      instance.getAccessToken(),
      instance.getAccessToken(),
      instance.getAccessToken(),
    ]);

    expect(calls).toBe(1);
    expect(results.map((r) => r.token)).toEqual([
      "spy-access-token",
      "spy-access-token",
      "spy-access-token",
    ]);
  });
});

// ─── plugin pendingRequests under parallel requests ────────────────────────

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

describe("plugin pendingRequests under parallel in-flight requests (plan §30)", () => {
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

  /** Minimal fake plugin context capturing the registered hook handlers. */
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

  function makeReqEvent(bodyJson: string): TestEvent {
    return {
      request: {
        url: "https://api.giga.chat/v2/chat/completions",
        method: "POST",
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(bodyJson).buffer),
      },
      model: { providerID: "gigachat" },
    };
  }

  function okResponse(content: string): Response {
    return new Response(
      JSON.stringify({
        id: "cmpl-c",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  test("concurrent in-flight requests keep distinct RqUID snapshots and clean up", async () => {
    const { ctx, hooks } = fakeCtx();
    await plugin.setup(ctx);
    try {
      expect(pendingRequestCount()).toBe(0);

      // Both requests stall at the token gate → genuinely in-flight together
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      authManager.getAccessToken = async () => {
        await gate;
        return {
          token: "test-token",
          account: { id: "t", name: "t", credentials: "t", scope: "GIGACHAT_API_PERS" },
        };
      };

      const evA = makeReqEvent(
        '{"model":"GigaChat-2-Max","messages":[{"role":"user","content":"A"}]}',
      );
      const evB = makeReqEvent(
        '{"model":"GigaChat-2-Max","messages":[{"role":"user","content":"B"}]}',
      );
      const inFlightA = hooks["http.request"](evA);
      const inFlightB = hooks["http.request"](evB);

      // Before the gate opens: both pending at auth, no snapshots yet
      await Promise.resolve();
      expect(pendingRequestCount()).toBe(0);

      release();
      await Promise.all([inFlightA, inFlightB]);

      // After the gate: two RqUID-keyed snapshots, keys distinct
      expect(pendingRequestCount()).toBe(2);
      const rquidA = evA.request.headers.get("RqUID");
      const rquidB = evB.request.headers.get("RqUID");
      expect(rquidA).not.toBe(rquidB);
      expect((rquidA ?? "") !== "").toBe(true);

      // Parallel response processing cleans both up
      await Promise.all([
        hooks["http.response"]({
          request: evA.request,
          response: okResponse("A"),
          model: { providerID: "gigachat" },
        }),
        hooks["http.response"]({
          request: evB.request,
          response: okResponse("B"),
          model: { providerID: "gigachat" },
        }),
      ]);
      expect(pendingRequestCount()).toBe(0);
    } finally {
      // afterEach restores the authManager
    }
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Normalized response carrying one tool call with the given wire name. */
function normalizedWithTool(name: string): NormalizedResponse {
  return {
    id: "r-1",
    created: 1,
    model: "GigaChat-2-Max",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          contentParts: [],
          toolCalls: [{ id: "call_1", name, arguments: {} }],
        },
        finishReason: "tool_calls",
      },
    ],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

/** Normalized request declaring one tool with the given name. */
function normalizedRequestWithTool(name: string): Parameters<typeof aliasNamesInRequest>[0] {
  return {
    model: "GigaChat-2-Max",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ name, parameters: { type: "object" } }],
  };
}

/** Minimal OpenAI chat request body with one unsafe tool name. */
function chatBody(toolName: string) {
  return {
    model: "GigaChat-2-Max",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [{ type: "function" as const, function: { name: toolName, parameters: {} } }],
  };
}

/** V2 SSE wire payload that carries a function_call with the given name. */
function aliasDoneStream(alias: string): string {
  const delta = JSON.stringify({
    messages: [{ role: "assistant", content: [{ function_call: { name: alias, arguments: {} } }] }],
  });
  const done = JSON.stringify({ finish_reason: "function_call" });
  return `event: response.message.delta\ndata: ${delta}\n\nevent: response.message.done\ndata: ${done}\n\n`;
}

/** Runtime handle to tap the private fetchToken method for dedupe counting. */
function refresher(instance: GigaCodeAuthManager): { fetchToken(): Promise<string> } {
  return instance as unknown as { fetchToken(): Promise<string> };
}
