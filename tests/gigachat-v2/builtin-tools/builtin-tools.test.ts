/**
 * PHASE 11 §24 — V2 compatibility suite: builtin-tools zone.
 *
 * Contract table:
 *
 *   NormalizedTool.builtin ──normalizedToGigaChatV2──▶ keyed wire entry
 *   fake builtin response (plain text) ──▶ no function_call on the OpenCode
 *   surface (builtins execute server-side — live-verified 2026-09-16).
 *
 * Pinned facts:
 * - known builtin ids (web_search, url_content_extraction, image_generate,
 *   model_3d_generate) map to keyed wire entries, never specifications;
 * - unknown builtin ids raise a controlled error (never a guess);
 * - forced choice on a builtin uses `tool_name`, on a custom function uses
 *   `function_name` (spec: tool_config).
 */
import { describe, expect, test } from "bun:test";
import type { ChatCompletionV2Response } from "../../../src/gigachat/v2/types";
import { gigachatV2ToNormalized } from "../../../src/translation/gigachat-v2-to-normalized";
import { normalizedToGigaChatV2 } from "../../../src/translation/normalized-to-gigachat-v2";
import { normalizedToOpenCode } from "../../../src/translation/normalized-to-opencode";

const userText = [{ type: "text" as const, text: "go" }];

const webSearchV2Response: ChatCompletionV2Response = {
  model: "GigaChat-2-Max",
  created_at: 1700000000,
  finish_reason: "stop",
  messages: [{ role: "assistant", content: [{ text: "Moscow weather: -5°C" }] }],
  usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
};

describe("§24 builtin-tools zone — wire entries", () => {
  test("known builtin id → keyed wire entry (no specifications)", () => {
    const wire = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [{ role: "user", content: userText }],
      tools: [{ name: "search", builtin: "web_search" }],
    });
    expect(wire.tools).toEqual([{ web_search: {} }]);
  });

  test("custom + builtin mix → specifications entry first, then builtin entries", () => {
    const wire = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [{ role: "user", content: userText }],
      tools: [
        { name: "custom", parameters: { type: "object" } },
        { name: "img", builtin: "image_generate" },
        { name: "urls", builtin: "url_content_extraction" },
      ],
    });
    expect(wire.tools).toEqual([
      { functions: { specifications: [{ name: "custom", parameters: { type: "object" } }] } },
      { image_generate: {} },
      { url_content_extraction: {} },
    ]);
  });

  test("forced builtin choice → tool_name; forced custom → function_name", () => {
    const builtin = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [{ role: "user", content: userText }],
      tools: [{ name: "search", builtin: "web_search" }],
      toolChoice: { functionName: "web_search" },
    });
    expect(builtin.tool_config).toEqual({ mode: "forced", tool_name: "web_search" });

    const custom = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [{ role: "user", content: userText }],
      tools: [{ name: "echo", parameters: { type: "object" } }],
      toolChoice: { functionName: "echo" },
    });
    expect(custom.tool_config).toEqual({ mode: "forced", function_name: "echo" });
  });

  test("unknown builtin id → controlled error (never a guess)", () => {
    expect(() =>
      normalizedToGigaChatV2({
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: userText }],
        tools: [{ name: "x", builtin: "code_interpreter" }],
      }),
    ).toThrow(/unknown builtin tool "code_interpreter"/);
  });
});

describe("§24 builtin-tools zone — response contract", () => {
  test("builtin call arrives as plain text, no function_call (server-side execution)", () => {
    const out = normalizedToOpenCode(gigachatV2ToNormalized(webSearchV2Response));
    expect(out.choices[0].message.content).toBe("Moscow weather: -5°C");
    expect(out.choices[0].message.tool_calls).toBeUndefined();
    expect(out.choices[0].finish_reason).toBe("stop");
  });
});
