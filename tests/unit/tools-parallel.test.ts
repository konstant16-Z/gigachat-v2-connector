/**
 * Unit tests: parallel tool-call linkage (plan §10).
 *
 * The identity invariant — tool_1 → result_1, never tool_1 → result_2 — must
 * hold for 1..n parallel calls, mixed with text/errors, and reorders.
 */
import { describe, expect, test } from "bun:test";
import type { ToolCallRef } from "../../src/gigachat/v2/tools/normalize";
import { type ToolResultRef, verifyToolLinkage } from "../../src/gigachat/v2/tools/parallel";
import { normalizedToGigaChatV2 } from "../../src/translation/normalized-to-gigachat-v2";

function callSet(n: number): ToolCallRef[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `call_${i + 1}`,
    name: `fn_${i + 1}`,
  }));
}

function resultSet(n: number, startIndex = 0): ToolResultRef[] {
  return Array.from({ length: n }, (_, i) => ({
    index: startIndex + i,
    toolCallId: `call_${i + 1}`,
  }));
}

describe("verifyToolLinkage", () => {
  test("single tool: linked with resolved name", () => {
    const l = verifyToolLinkage(callSet(1), resultSet(1));
    expect(l.linked).toEqual([{ index: 0, callId: "call_1", name: "fn_1" }]);
    expect(l.missingCalls).toEqual([]);
    expect(l.duplicateResults).toEqual([]);
    expect(l.orphanResults).toEqual([]);
  });

  test("two parallel tools keep identity (call_1 → result for call_1)", () => {
    const l = verifyToolLinkage(callSet(2), resultSet(2));
    expect(l.linked.map((x) => x.name)).toEqual(["fn_1", "fn_2"]);
    expect(l.linked.map((x) => x.callId)).toEqual(["call_1", "call_2"]);
  });

  test("five tools", () => {
    const l = verifyToolLinkage(callSet(5), resultSet(5));
    expect(l.linked).toHaveLength(5);
    expect(l.linked[4]).toEqual({ index: 4, callId: "call_5", name: "fn_5" });
  });

  test("ten tools", () => {
    const l = verifyToolLinkage(callSet(10), resultSet(10));
    expect(l.linked).toHaveLength(10);
    expect(l.orphanResults).toEqual([]);
  });

  test("results may arrive in any order, linkage follows input order", () => {
    const l = verifyToolLinkage(callSet(3), [
      { index: 0, toolCallId: "call_3" },
      { index: 1, toolCallId: "call_1" },
      { index: 2, toolCallId: "call_2" },
    ]);
    expect(l.linked.map((x) => x.name)).toEqual(["fn_3", "fn_1", "fn_2"]);
    expect(l.orphanResults).toEqual([]);
  });

  test("orphan: unknown tool_call_id is reported, never silently linked", () => {
    const l = verifyToolLinkage(callSet(1), [{ index: 0, toolCallId: "call_999" }]);
    expect(l.orphanResults).toEqual([{ index: 0, toolCallId: "call_999", name: undefined }]);
    expect(l.linked).toEqual([]);
  });

  test("duplicate: second result for the same call is reported", () => {
    const l = verifyToolLinkage(callSet(1), [
      { index: 0, toolCallId: "call_1" },
      { index: 1, toolCallId: "call_1" },
    ]);
    expect(l.linked).toHaveLength(1);
    expect(l.duplicateResults).toEqual([{ index: 1, toolCallId: "call_1", name: undefined }]);
    // first call had a result, so nothing is missing
    expect(l.missingCalls).toEqual([]);
  });

  test("missing: call without any result is listed as informational", () => {
    const l = verifyToolLinkage(callSet(3), [
      { index: 0, toolCallId: "call_1" },
      { index: 1, toolCallId: "call_3" },
    ]);
    expect(l.missingCalls).toEqual(["call_2"]);
    expect(l.linked).toHaveLength(2);
  });

  test("legacy-style result with explicit name links without an id", () => {
    const l = verifyToolLinkage([], [{ index: 0, name: "math" }]);
    expect(l.linked).toEqual([{ index: 0, name: "math" }]);
    expect(l.orphanResults).toEqual([]);
  });

  test("tool + text: text parts are not tool results and stay out of linkage", () => {
    const l = verifyToolLinkage(callSet(1), resultSet(1));
    expect(l.linked).toHaveLength(1);
  });
});

describe("request mapping enforces the identity invariant", () => {
  test("duplicate tool results for one call raise a controlled error", () => {
    expect(() =>
      normalizedToGigaChatV2({
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "assistant",
            content: [],
            toolCalls: [{ id: "call_1", name: "math", arguments: { op: "add" } }],
          },
          {
            role: "tool",
            content: [
              { type: "tool_result", toolCallId: "call_1", result: "2" },
              { type: "tool_result", toolCallId: "call_1", result: "3" },
            ],
          },
        ],
      }),
    ).toThrow(/duplicate tool result for call call_1/);
  });

  test("orphan tool result still raises the resolvable-name error", () => {
    expect(() =>
      normalizedToGigaChatV2({
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "unknown-id", result: "{}" }],
          },
        ],
      }),
    ).toThrow(/without a resolvable function name/);
  });

  test("mixed success and error results map in order with correct names", () => {
    const v2 = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Running." }],
          toolCalls: [
            { id: "c1", name: "get_weather", arguments: { city: "Moscow" } },
            { id: "c2", name: "get_time", arguments: {} },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", toolCallId: "c2", result: '{"hour":12}' },
            { type: "tool_result", toolCallId: "c1", result: '{"temp":-5}' },
          ],
        },
      ],
    });
    const results = v2.messages[1].content;
    expect(results).toEqual([
      { function_result: { name: "get_time", result: '{"hour":12}' } },
      { function_result: { name: "get_weather", result: '{"temp":-5}' } },
    ]);
  });
});
