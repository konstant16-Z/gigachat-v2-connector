/**
 * PHASE 11 §24 — V2 compatibility suite: tools zone.
 *
 * Contract table:
 *
 *   tool declarations / tool_choice ──chatRequest──▶ expected wire
 *   fake function_call response ──jsonResponse──▶ expected OpenCode tool_calls
 *
 * Pinned wire facts:
 * - custom functions live under `tools[{functions:{specifications}}]`;
 * - tool_choice maps to `tool_config.mode` (auto|none|forced); `required` is
 *   not representable and raises a controlled error (agents.md RULE 13);
 * - legacy `role:"function"` results without a tool_call_id cannot be linked —
 *   controlled error instead of a silently guessed name;
 * - V2-unsafe names get deterministic per-session `tool_<n>` aliases.
 */
import { describe, expect, test } from "bun:test";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";
import { builtinToolRequest, legacyFunctionRequest } from "../../fixtures/requests/openai";
import { toolCallV2Response } from "../../fixtures/responses/v2";

const noop = (): void => {};

const echoTool = {
  type: "function" as const,
  function: { name: "echo", parameters: { type: "object" } },
};

describe("§24 tools zone — declaration & choice wire contract", () => {
  test("custom functions → functions.specifications; auto becomes explicit", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        tool_choice: "auto",
      },
      "tools-sess",
    );
    expect(wire.tool_config).toEqual({ mode: "auto" });
    expect(wire.tools).toEqual([
      {
        functions: {
          specifications: [
            {
              name: "get_weather",
              description: "weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          ],
        },
      },
    ]);
  });

  test("tool_choice none → mode none; forced custom → function_name", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const none = await pipeline.chatRequest(builtinToolRequest, "tools-sess");
    expect(none.tool_config).toEqual({ mode: "none" });

    const forced = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "use echo" }],
        tools: [echoTool],
        tool_choice: { function: { name: "echo" } },
      },
      "tools-sess",
    );
    expect(forced.tool_config).toEqual({ mode: "forced", function_name: "echo" });
  });

  test("tool_choice required → controlled error (auto|none|forced only)", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    await expect(
      pipeline.chatRequest(
        {
          model: "GigaChat-2-Max",
          messages: [{ role: "user", content: "go" }],
          tool_choice: "required",
        },
        "tools-sess",
      ),
    ).rejects.toThrow(/unsupported tool_choice "required"/);
  });

  test("legacy function result without a tool_call_id → controlled error (refuse to guess)", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    await expect(pipeline.chatRequest(legacyFunctionRequest, "tools-sess")).rejects.toThrow(
      /tool result without a tool_call_id or name/,
    );
  });

  test("V2-unsafe tool name → deterministic alias on the wire", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { type: "function", function: { name: "read file", parameters: { type: "object" } } },
        ],
      },
      "tools-sess",
    );
    const firstTool = wire.tools?.[0];
    if (firstTool === undefined || !("functions" in firstTool)) {
      throw new Error("expected a functions.specifications wire entry");
    }
    const spec = firstTool.functions.specifications[0];
    expect(spec?.name).toBe("tool_1");
    expect(spec?.parameters).toEqual({ type: "object" });
  });
});

describe("§24 tools zone — response contract", () => {
  test("function_call response → linked OpenCode tool_calls + state", () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const out = pipeline.jsonResponse(toolCallV2Response, "tools-sess");

    const message = out.choices[0].message;
    expect(message.content).toBe("Let me check.");
    expect(message.tool_calls).toEqual([
      {
        index: 0,
        id: "fc-live-1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Moscow"}' },
      },
    ]);
    expect(message.functions_state_id).toBe("state-abc-123");
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.usage).toEqual({ prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 });
  });
});
