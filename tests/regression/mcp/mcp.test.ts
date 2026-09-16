/**
 * PHASE 10 §23 — regression: MCP-sourced tools keep the V1 working behavior.
 *
 * MCP tools arrive on the OpenAI-compatible surface as ordinary function tools
 * (names like `mcp__<server>__<tool>`), with results as role-`tool` messages
 * keyed by tool_call_id. Origins: src/v2/toolRegistry.ts + translator.ts
 * (tool/function role handling, name aliasing, linkage by tool_call_id).
 */
import { describe, expect, test } from "bun:test";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";

const MCP_VALID = "mcp__filesystem__read_file";
const MCP_UNSAFE = "mcp server";

describe("§23 mcp — declarations", () => {
  test("spec-valid MCP name passes through to the wire", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "list files" }],
        tools: [
          {
            type: "function",
            function: {
              name: MCP_VALID,
              description: "read a file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      },
      "s-mcp-1",
    );
    const spec = wire.tools?.[0];
    if (spec === undefined || !("functions" in spec)) {
      throw new Error("expected a functions tool declaration on the wire");
    }
    expect(spec.functions.specifications[0].name).toBe(MCP_VALID);
  });

  test("unsafe MCP name is aliased (legacy toolRegistry parity)", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { type: "function", function: { name: MCP_UNSAFE, parameters: { type: "object" } } },
        ],
      },
      "s-mcp-2",
    );
    const spec = wire.tools?.[0];
    if (spec === undefined || !("functions" in spec)) {
      throw new Error("expected a functions tool declaration on the wire");
    }
    expect(spec.functions.specifications[0].name).toBe("tool_1");
  });

  test("forced choice on a builtin uses tool_name; custom function uses function_name", async () => {
    const pipeline = createV2Pipeline();
    const builtin = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "search" }],
        tool_choice: { function: { name: "web_search" } },
      },
      "s-mcp-3a",
    );
    expect(builtin.tool_config).toEqual({ mode: "forced", tool_name: "web_search" });
    const custom = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: { function: { name: MCP_VALID } },
      },
      "s-mcp-3b",
    );
    expect(custom.tool_config).toEqual({ mode: "forced", function_name: MCP_VALID });
  });
});

describe("§23 mcp — tool results", () => {
  test("tool_call_id resolves the result name from the prior assistant call", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "mcp-1", type: "function", function: { name: MCP_VALID, arguments: "{}" } },
            ],
          },
          // No `name` present: linkage is by tool_call_id (V1 toolCallIdToName).
          { role: "tool", tool_call_id: "mcp-1", content: '{"ok":true}' },
        ],
      },
      "s-mcp-4",
    );
    expect(wire.messages[1].content[0]).toEqual({
      function_result: { name: MCP_VALID, result: '"{\\"ok\\":true}"' },
    });
  });

  test("orphan result (unknown tool_call_id) is a controlled error, not a silent drop", async () => {
    const pipeline = createV2Pipeline();
    await expect(
      pipeline.chatRequest(
        {
          model: "GigaChat-2-Max",
          messages: [{ role: "tool", tool_call_id: "missing-1", content: "r" }],
        },
        "s-mcp-5",
      ),
    ).rejects.toThrow(/tool result without a resolvable function name \(tool_call_id=missing-1\)/);
  });

  test("result JSON is string-wrapped per the live V2 contract (400-free)", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "t2", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "t2", content: "plain text result" },
        ],
      },
      "s-mcp-6",
    );
    expect(wire.messages[1].content[0]).toEqual({
      function_result: { name: "f", result: '"plain text result"' },
    });
  });
});
