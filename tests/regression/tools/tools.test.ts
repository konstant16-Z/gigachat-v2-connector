/**
 * PHASE 10 §23 — regression: legacy tool behaviors must survive the V2 path.
 *
 * Origin of the behaviors pinned here: src/v2/toolRegistry.ts (global alias
 * registry) and src/v2/translator.ts (functions/tool_choice/tool messages /
 * functions_state_id). The V2 path replaces the *global* map with a
 * session-scoped ToolNameRegistry — same alias contract, no module-level
 * mutable state (agents.md §14). Deliberate divergences (tool_choice
 * "required", missing model, no implicit max_tokens) follow agents.md RULE 13:
 * controlled errors instead of silent guesses.
 */
import { describe, expect, test } from "bun:test";
import { ToolNameRegistry } from "../../../src/gigachat/v2/tools/normalize";
import type { ChatCompletionV2Response } from "../../../src/gigachat/v2/types";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";

const UNSAFE_NAME = "shell --- workdir /home/user";

describe("§23 tools — alias registry (legacy toolRegistry parity)", () => {
  test("unsafe name gets a deterministic alias; originalOf restores it", () => {
    const registry = new ToolNameRegistry();
    expect(registry.aliasFor(UNSAFE_NAME)).toBe("tool_1");
    expect(registry.aliasFor(UNSAFE_NAME)).toBe("tool_1"); // deterministic
    expect(registry.originalOf("tool_1")).toBe(UNSAFE_NAME);
  });

  test("spec-valid names pass through without bookkeeping", () => {
    const registry = new ToolNameRegistry();
    expect(registry.aliasFor("get_weather")).toBe("get_weather");
    expect(registry.originalOf("get_weather")).toBe("get_weather");
    expect(registry.size).toBe(0);
  });

  test("registries are session-scoped: same alias name, different originals", () => {
    const a = new ToolNameRegistry();
    const b = new ToolNameRegistry();
    a.aliasFor("shell --- workdir /home/user");
    b.aliasFor("bash --cwd /tmp");
    expect(a.originalOf("tool_1")).toBe(UNSAFE_NAME);
    expect(b.originalOf("tool_1")).toBe("bash --cwd /tmp");
  });
});

describe("§23 tools — pipeline request parity", () => {
  test("unsafe declaration is aliased on the wire, description/parameters kept", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: UNSAFE_NAME,
              description: "run a command",
              parameters: { type: "object", properties: { cmd: { type: "string" } } },
            },
          },
        ],
      },
      "s-tools-1",
    );
    const spec = wire.tools?.[0];
    if (spec === undefined || !("functions" in spec)) {
      throw new Error("expected a functions tool declaration on the wire");
    }
    expect(spec.functions.specifications[0]).toMatchObject({
      name: "tool_1",
      description: "run a command",
    });
  });

  test("safe declaration passes through unchanged", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "d", parameters: { type: "object" } },
          },
        ],
      },
      "s-tools-2",
    );
    const spec = wire.tools?.[0];
    if (spec === undefined || !("functions" in spec)) {
      throw new Error("expected a functions tool declaration on the wire");
    }
    expect(spec.functions.specifications[0].name).toBe("get_weather");
  });

  test("assistant tool_call and its result are aliased consistently", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "tc-1", type: "function", function: { name: UNSAFE_NAME, arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "tc-1", content: "done" },
        ],
      },
      "s-tools-3",
    );
    expect(wire.messages[0].content[0]).toEqual({
      function_call: { name: "tool_1", arguments: {} },
    });
    expect(wire.messages[1].content[0]).toEqual({
      function_result: { name: "tool_1", result: '"done"' },
    });
  });

  test("parallel tool calls keep order and ids (legacy pendingCalls parity)", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "f_a", arguments: "{}" } },
              { id: "b", type: "function", function: { name: "f_b", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "a", content: "r1" },
          { role: "tool", tool_call_id: "b", content: "r2" },
        ],
      },
      "s-tools-4",
    );
    const calls = wire.messages[0].content.map((c) =>
      "function_call" in c ? c.function_call : undefined,
    );
    expect(calls).toEqual([
      { name: "f_a", arguments: {} },
      { name: "f_b", arguments: {} },
    ]);
    const results = wire.messages.slice(1).map((m) => m.content[0]);
    expect(results).toEqual([
      { function_result: { name: "f_a", result: '"r1"' } },
      { function_result: { name: "f_b", result: '"r2"' } },
    ]);
  });

  test("tool_choice parity — V1 surface maps to V2 tool_config", async () => {
    const pipeline = createV2Pipeline();
    const body = (tool_choice: string | { function?: { name?: string } }) =>
      pipeline.chatRequest(
        {
          model: "GigaChat-2-Max",
          messages: [{ role: "user", content: "hi" }],
          tools: [
            { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
          ],
          tool_choice,
        },
        "s-tools-5",
      );
    expect((await body("none")).tool_config).toEqual({ mode: "none" });
    expect((await body("auto")).tool_config).toEqual({ mode: "auto" });
    expect((await body({ function: { name: "get_weather" } })).tool_config).toEqual({
      mode: "forced",
      function_name: "get_weather",
    });
    // Divergence: V1 mapped "required" → "auto" silently; V2 refuses to guess.
    await expect(body("required")).rejects.toThrow(/unsupported tool_choice "required"/);
  });

  test("legacy functions array still reaches the wire as tools (no silent drop)", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        functions: [{ name: "legacy_fn", description: "d", parameters: { type: "object" } }],
      },
      "s-tools-6",
    );
    const spec = wire.tools?.[0];
    if (spec === undefined || !("functions" in spec)) {
      throw new Error("expected a functions tool declaration on the wire");
    }
    expect(spec.functions.specifications[0].name).toBe("legacy_fn");
  });

  test("missing model → controlled error (V1 defaulted GigaChat-Max; V2 refuses)", async () => {
    const pipeline = createV2Pipeline();
    await expect(
      pipeline.chatRequest({ messages: [{ role: "user", content: "hi" }] }, "s-tools-7"),
    ).rejects.toThrow(/V2 request requires `model`/);
  });

  test("no implicit max_tokens (V1 defaulted 1024; V2 explicit-only)", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      { model: "GigaChat-2-Max", messages: [{ role: "user", content: "hi" }] },
      "s-tools-8",
    );
    expect(wire.model_options?.max_tokens).toBeUndefined();
  });

  test("functions_state_id round-trips: request passthrough + response capture → next request", async () => {
    const pipeline = createV2Pipeline();
    // Request side: client-provided history state forwarded verbatim.
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "assistant",
            content: "ok",
            functions_state_id: "state-from-history",
            tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "t", content: "r" },
        ],
      },
      "s-tools-9",
    );
    expect(wire.messages[0].functions_state_id).toBe("state-from-history");
    // Response side: capture a fresh tool_state_id, inject into the next request.
    const resp: ChatCompletionV2Response = {
      model: "GigaChat-2-Max",
      created_at: 1234,
      finish_reason: "stop",
      messages: [{ role: "assistant", tool_state_id: "state-new-1", content: [{ text: "ok" }] }],
    };
    pipeline.jsonResponse(resp, "s-tools-9");
    const next = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [
          { role: "user", content: "next" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "t2", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "t2", content: "r2" },
        ],
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
      },
      "s-tools-9",
    );
    expect(next.messages[1].functions_state_id).toBe("state-new-1");
  });
});

describe("§23 tools — response name restoration (legacy getOriginalToolName parity)", () => {
  test("JSON response: aliased function_call name restored to the original", async () => {
    const pipeline = createV2Pipeline();
    // Register the alias in this session by sending the unsafe tool first.
    await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { type: "function", function: { name: UNSAFE_NAME, parameters: { type: "object" } } },
        ],
      },
      "s-tools-x",
    );
    const resp: ChatCompletionV2Response = {
      model: "GigaChat-2-Max",
      created_at: 1234,
      finish_reason: "function_call",
      messages: [
        {
          role: "assistant",
          content: [
            { function_call: { id: "fc-1", name: "tool_1", arguments: { city: "Moscow" } } },
          ],
        },
      ],
    };
    const out = pipeline.jsonResponse(resp, "s-tools-x");
    expect(out.choices[0].message.tool_calls?.[0].function.name).toBe(UNSAFE_NAME);
  });

  test("streaming response: aliased function_call restored per session", async () => {
    const pipeline = createV2Pipeline();
    // Register the alias in this session first.
    await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { type: "function", function: { name: UNSAFE_NAME, parameters: { type: "object" } } },
        ],
      },
      "s-tools-y",
    );
    const upstream = new Response(
      new Blob([
        new TextEncoder().encode(
          'event: response.message.delta\ndata: {"messages":[{"content":[{"function_call":{"name":"tool_1","arguments":{"city":"Moscow"}}}]}]}\n\n' +
            'event: response.message.done\ndata: {"finish_reason":"function_call"}\n\n',
        ),
      ]),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const out = pipeline.streamingResponse(upstream, "s-tools-y");
    const body = await out.text();
    const names = body
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(
        (l) =>
          JSON.parse(l.slice(6)) as {
            choices: Array<{ delta: { tool_calls?: Array<{ function: { name: string } }> } }>;
          },
      )
      .flatMap((c) => c.choices.flatMap((ch) => ch.delta.tool_calls ?? []))
      .map((tc) => tc.function.name);
    expect(names).toContain(UNSAFE_NAME);
  });

  test("unknown alias passes through untouched (only session aliases are restored)", () => {
    const pipeline = createV2Pipeline();
    const resp: ChatCompletionV2Response = {
      model: "GigaChat-2-Max",
      created_at: 1234,
      finish_reason: "function_call",
      messages: [
        {
          role: "assistant",
          content: [{ function_call: { id: "fc-1", name: "get_weather", arguments: {} } }],
        },
      ],
    };
    const out = pipeline.jsonResponse(resp, "s-tools-z");
    expect(out.choices[0].message.tool_calls?.[0].function.name).toBe("get_weather");
  });
});
