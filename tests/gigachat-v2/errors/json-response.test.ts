/**
 * PHASE 11 §28 — malformed JSON response suite (GigaChat V2 → normalized).
 *
 * Rule: malformed response → controlled error (throw with a clear message or a
 * graceful degraded result), never an undefined/null crash. Throws raised by
 * the direct mapper are wrapped by the upstream layer into a 502 proxy error.
 */
import { describe, expect, test } from "bun:test";
import type { ChatCompletionV2Response } from "../../../src/gigachat/v2/types";
import { gigachatV2ToNormalized } from "../../../src/translation/gigachat-v2-to-normalized";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";
import { toolCallV2Response } from "../../fixtures/responses/v2";

/**
 * The wire is untrusted: broken variants are legal test inputs even when they
 * violate the typed union — widen deliberately at the boundary.
 */
function broken(messages: unknown, overrides: object = {}): ChatCompletionV2Response {
  return {
    ...toolCallV2Response,
    ...overrides,
    messages,
  } as unknown as ChatCompletionV2Response;
}

describe("§28 malformed JSON response — controlled errors", () => {
  test("missing choices (no messages key) → controlled error", () => {
    expect(() => gigachatV2ToNormalized(broken(undefined))).toThrow(
      /malformed V2 response: "messages" is missing or not an array/,
    );
    expect(() => gigachatV2ToNormalized(broken("nope"))).toThrow(
      /malformed V2 response: "messages" is missing or not an array/,
    );
  });

  test("non-object envelope → controlled error", () => {
    expect(() => gigachatV2ToNormalized(null as unknown as ChatCompletionV2Response)).toThrow(
      /malformed V2 response: expected a JSON object/,
    );
    expect(() => gigachatV2ToNormalized([] as unknown as ChatCompletionV2Response)).toThrow(
      /malformed V2 response: expected a JSON object/,
    );
  });

  test("missing message (empty messages array) → graceful empty completion", () => {
    const n = gigachatV2ToNormalized(broken([], { usage: undefined }));
    expect(n.choices).toEqual([]);
    expect(n.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  test("message is not an object → controlled error", () => {
    expect(() => gigachatV2ToNormalized(broken([null]))).toThrow(
      /malformed V2 response: message at index 0 is not an object/,
    );
  });

  test("missing content array → controlled error", () => {
    expect(() => gigachatV2ToNormalized(broken([{ role: "assistant" }]))).toThrow(
      /malformed V2 response: message at index 0 is missing a content array/,
    );
  });

  test("malformed tool call (function_call null) → controlled error", () => {
    expect(() =>
      gigachatV2ToNormalized(broken([{ role: "assistant", content: [{ function_call: null }] }])),
    ).toThrow(/malformed V2 response: function_call is not an object/);
  });

  test("function_call without a name → controlled error", () => {
    expect(() =>
      gigachatV2ToNormalized(
        broken([{ role: "assistant", content: [{ function_call: { arguments: { city: "M" } } }] }]),
      ),
    ).toThrow(/malformed V2 response: function_call without a name/);
  });

  test("missing tool_call_id → generated id, no crash", () => {
    const n = gigachatV2ToNormalized(
      broken([{ role: "assistant", content: [{ function_call: { name: "f", arguments: {} } }] }]),
    );
    expect(n.choices[0].message.toolCalls?.[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("invalid JSON arguments → controlled error", () => {
    expect(() =>
      gigachatV2ToNormalized(
        broken([
          { role: "assistant", content: [{ function_call: { name: "f", arguments: "{oops" } }] },
        ]),
      ),
    ).toThrow(/malformed tool arguments JSON/);
  });

  test("unexpected finish reason → mapped to null, no crash", () => {
    const n = gigachatV2ToNormalized(
      broken(toolCallV2Response.messages, { finish_reason: "mystery" }),
    );
    expect(n.choices[0].finishReason).toBeNull();
  });

  test("missing usage → zeroed usage, no crash", () => {
    const n = gigachatV2ToNormalized(broken(toolCallV2Response.messages, { usage: undefined }));
    expect(n.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  test("unknown fields ignored, no crash", () => {
    const n = gigachatV2ToNormalized(
      broken([{ role: "assistant", content: [{ text: "ok", mystery_key: { deep: true } }] }], {
        x_custom: { anything: [1, 2, 3] },
      }),
    );
    expect(n.model).toBe("GigaChat-2-Max");
    expect(n.choices[0].message.content).toBe("ok");
  });

  test("malformed tool_execution → controlled error", () => {
    expect(() =>
      gigachatV2ToNormalized(
        broken([{ role: "assistant", content: [{ text: "x", tool_execution: null }] }]),
      ),
    ).toThrow(/malformed V2 response: tool_execution is not an object/);
  });

  test("files non-array → skipped gracefully, no crash", () => {
    const n = gigachatV2ToNormalized(
      broken([{ role: "assistant", content: [{ text: "x", files: "nope" }] }]),
    );
    expect(n.choices[0].message.contentParts).toEqual([{ type: "text", text: "x" }]);
  });

  test("malformed envelope surfaces as a 502 proxy error upstream", async () => {
    const pipeline = createV2Pipeline();
    const upstream = new Response("null", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const out = await pipeline.jsonResponseFromUpstream(upstream, "s-1");
    expect(out.status).toBe(502);
    const body = (await out.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/malformed V2 response/);
  });
});
