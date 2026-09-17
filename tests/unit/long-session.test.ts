/**
 * PHASE 12 §27 — long-session test (offline companion to the live harness).
 *
 * Simulates the plan's agent loop without network access:
 *
 *   inspect → find → modify → run tests → inspect failure → fix → run tests → review
 *
 * 24 sequential turns (~27 tool interactions, within the plan's 20–30 budget)
 * are driven through the real V2 translation pipeline in ONE session:
 *
 *   chatRequest (history → V2 wire) → upstream V2 response → jsonResponse
 *   (V2 → OpenCode) → append assistant + tool results → next turn
 *
 * Checked across the whole session:
 *   - tool IDs      — preserved from the wire and unique session-wide;
 *   - tool state    — `tool_state_id` captured → `functions_state_id` injected
 *                     on the next request (natural multi-turn round-trip);
 *   - context       — every history message survives to the wire, in order;
 *   - streaming     — an SSE turn maps reasoning + text + two tool calls and
 *                     captures the nested state id at flush;
 *   - reasoning     — `reasoning_content` deltas surface on the OpenCode SSE;
 *   - errors        — a malformed payload is a controlled error and does not
 *                     corrupt the state captured so far;
 *   - token usage   — usage accumulates monotonically turn over turn;
 *   - concurrency   — one assistant message may carry two parallel tool calls;
 *   - cancellation  — an aborted stream propagates upstream and leaves the
 *                     session usable.
 *
 * The live counterpart (real OpenCode + GigaChat API) is
 * `scripts/smoke/run-long-session.sh`; see `docs/LONG_SESSION.md`.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatCompletionV2Request,
  ChatCompletionV2Response,
  V2ResponseContentItem,
} from "../../src/gigachat/v2/types";
import { createV2Pipeline } from "../../src/translation/v2-pipeline";
import type {
  GigaChatToolCall,
  OpenAiChatBody,
  OpenAiChatCompletion,
  OpenAiMessage,
} from "../../src/types/gigachat";

const noop = (): void => {};

const SESSION = "long-session";

/** Two safe names and one V2-unsafe name (aliased to `tool_1` on the wire). */
const TOOLS: OpenAiChatBody["tools"] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a shell command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: { name: "edit file", description: "Edit a file", parameters: { type: "object" } },
  },
];

interface PlannedCall {
  id: string;
  /** Wire name (may be the `tool_1` alias for the unsafe declaration). */
  name: string;
  args: Record<string, unknown>;
}

/**
 * Deterministic call plan for a turn:
 *   - every 8th turn: two parallel calls in a single assistant message;
 *   - every 5th turn (not 8th): the unsafe tool, travelling as its `tool_1` alias.
 */
function planTurn(turn: number): PlannedCall[] {
  if (turn % 8 === 0) {
    return [
      { id: `fc-${turn}-a`, name: "read_file", args: { path: `src/f${turn}.ts` } },
      { id: `fc-${turn}-b`, name: "run_shell", args: { cmd: "bun test" } },
    ];
  }
  if (turn % 5 === 0) {
    return [{ id: `fc-${turn}`, name: "tool_1", args: { path: `src/f${turn}.ts` } }];
  }
  return [{ id: `fc-${turn}`, name: "read_file", args: { path: `src/f${turn}.ts` } }];
}

/** A V2 tool-call response for one turn (unique state id + usage per turn). */
function v2ToolResponse(turn: number, calls: PlannedCall[]): ChatCompletionV2Response {
  const content: V2ResponseContentItem[] = [
    { text: `Turn ${turn}` },
    ...calls.map((call) => ({
      function_call: { id: call.id, name: call.name, arguments: call.args },
    })),
  ];
  return {
    model: "GigaChat-2-Max",
    created_at: 1_700_000_000 + turn,
    finish_reason: "function_call",
    messages: [{ role: "assistant", tool_state_id: `state-${turn}`, content }],
    usage: { input_tokens: turn * 10, output_tokens: 5, total_tokens: turn * 10 + 5 },
  };
}

function requireToolCalls(message: { tool_calls?: GigaChatToolCall[] }): GigaChatToolCall[] {
  const calls = message.tool_calls;
  if (calls === undefined) throw new Error("expected tool_calls on the translated message");
  return calls;
}

/** Function names actually declared on the V2 wire (in declaration order). */
function wireFunctionNames(body: ChatCompletionV2Request): string[] {
  const names: string[] = [];
  for (const tool of body.tools ?? []) {
    if ("functions" in tool) {
      for (const spec of tool.functions.specifications) names.push(spec.name);
    }
  }
  return names;
}

function lastAssistant(messages: Array<{ role: string; functions_state_id?: string }>) {
  return [...messages].reverse().find((m) => m.role === "assistant");
}

function byteStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function bodyReader(response: Response) {
  const body = response.body;
  if (body === null) throw new Error("expected a streaming response body");
  return body.getReader();
}

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

interface ParsedChunk {
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: GigaChatToolCall[];
  finish_reason: string | null;
}

function parseSseChunks(body: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning_content?: string;
          tool_calls?: GigaChatToolCall[];
        };
        finish_reason?: string | null;
      }>;
    };
    const choice = parsed.choices?.[0];
    if (choice?.delta === undefined) continue;
    chunks.push({
      ...(choice.delta.content !== undefined ? { content: choice.delta.content } : {}),
      ...(choice.delta.reasoning_content !== undefined
        ? { reasoning_content: choice.delta.reasoning_content }
        : {}),
      ...(choice.delta.tool_calls !== undefined ? { tool_calls: choice.delta.tool_calls } : {}),
      finish_reason: choice.finish_reason ?? null,
    });
  }
  return chunks;
}

/* ─────────────────────── long JSON tool loop (24 turns) ─────────────────── */

describe("§27 long session — 24-turn tool loop through the V2 pipeline", () => {
  test("tool ids, state, context, usage and concurrency stay consistent all session", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const history: OpenAiMessage[] = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Run the inspect → fix → test loop." },
    ];
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    let expectedUsage = 0;
    let expectedToolCalls = 0;
    let lastState: string | undefined;

    const TURNS = 24;
    for (let turn = 1; turn <= TURNS; turn += 1) {
      const wire = await pipeline.chatRequest(
        { model: "GigaChat-2-Max", messages: history, tools: TOOLS, tool_choice: "auto" },
        SESSION,
      );

      // Context: every history message survives to the wire, in order.
      expect(wire.messages.length).toBe(history.length);
      // Declarations: the unsafe name is deterministically aliased per session.
      expect(wireFunctionNames(wire)).toEqual(["read_file", "run_shell", "tool_1"]);
      // Tool state: after the first capture, the id is injected on the last
      // assistant message of the next request.
      if (lastState !== undefined) {
        expect(lastAssistant(wire.messages)?.functions_state_id).toBe(lastState);
      }

      // §27 errors: a malformed payload is controlled and must not corrupt state.
      if (turn === 4) {
        expect(() =>
          pipeline.jsonResponse(
            {
              model: "GigaChat-2-Max",
              finish_reason: "stop",
            } as unknown as ChatCompletionV2Response,
            SESSION,
          ),
        ).toThrow(/malformed V2 response/);
        expect(pipeline.store.getToolsStateId(SESSION)).toBe("state-3");
      }

      const calls = planTurn(turn);
      const out: OpenAiChatCompletion = pipeline.jsonResponse(v2ToolResponse(turn, calls), SESSION);
      const message = out.choices[0].message;
      const toolCalls = requireToolCalls(message);

      // Tool ids: preserved from the wire and unique across the whole session.
      expect(toolCalls.map((call) => call.id)).toEqual(calls.map((call) => call.id));
      for (const call of toolCalls) {
        const id = call.id ?? "";
        expect(id.length).toBeGreaterThan(0);
        expect(seenIds.has(id)).toBe(false);
        seenIds.add(id);
        // Names come back restored: the `tool_1` alias never leaks to OpenCode.
        expect(call.function.name).not.toBe("tool_1");
        seenNames.add(call.function.name);
      }
      // The unsafe declaration round-trips back to its original name.
      if (calls[0]?.name === "tool_1") {
        expect(toolCalls[0]?.function.name).toBe("edit file");
      }

      // Tool state captured and exposed to the OpenCode surface.
      lastState = `state-${turn}`;
      expect(message.functions_state_id).toBe(lastState);
      expect(pipeline.store.getToolsStateId(SESSION)).toBe(lastState);

      // Token usage accumulates turn over turn.
      expect(out.usage.prompt_tokens).toBe(turn * 10);
      expect(out.usage.total_tokens).toBe(turn * 10 + 5);
      expectedUsage += out.usage.total_tokens;

      history.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });
      for (const call of toolCalls) {
        history.push({ role: "tool", tool_call_id: call.id, content: "ok" });
      }
      expectedToolCalls += toolCalls.length;
    }

    // 24 single-call turns + 3 extra calls (parallel turns 8/16/24) = 27.
    expect(expectedToolCalls).toBe(27);
    expect(seenIds.size).toBe(27);
    expect(expectedUsage).toBeGreaterThan(0);
    expect(seenNames).toEqual(new Set(["read_file", "run_shell", "edit file"]));
    expect(history.length).toBe(2 + TURNS + expectedToolCalls);
    expect(pipeline.store.size).toBe(1);
  });
});

/* ─────────────── streaming, reasoning, cancellation & recovery ─────────── */

describe("§27 long session — streaming, reasoning, cancellation & recovery", () => {
  test("SSE turn maps reasoning + two tool calls and captures state at flush", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const stream =
      frame("response.message.delta", {
        messages: [{ role: "assistant", reasoning_content: "Думаю..." }],
      }) +
      frame("response.message.delta", { messages: [{ content: [{ text: "Готово" }] }] }) +
      frame("response.message.done", {
        model: "GigaChat-2-Max",
        created_at: 1_700_000_100,
        messages: [
          {
            role: "assistant",
            tool_state_id: "state-stream",
            content: [
              { function_call: { name: "read_file", arguments: { path: "src/a.ts" } } },
              { function_call: { name: "run_shell", arguments: { cmd: "bun test" } } },
            ],
          },
        ],
        finish_reason: "function_call",
        usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
      });

    const out = pipeline.streamingResponse(new Response(byteStream(stream)), SESSION);
    const body = await collectText(out);
    const chunks = parseSseChunks(body);

    // reasoning → `reasoning_content` delta; text → `content` delta.
    expect(chunks.some((c) => c.reasoning_content === "Думаю...")).toBe(true);
    expect(chunks.some((c) => c.content === "Готово")).toBe(true);
    // one assistant message → two parallel tool calls with stable sequential ids.
    const toolChunks = chunks.flatMap((c) => c.tool_calls ?? []);
    expect(toolChunks.map((c) => c.id)).toEqual(["call_1", "call_2"]);
    expect(toolChunks.map((c) => c.function.name)).toEqual(["read_file", "run_shell"]);
    // finish_reason "function_call" → OpenAI "tool_calls"; stream is terminated.
    expect(chunks.map((c) => c.finish_reason).filter((r) => r !== null)).toEqual(["tool_calls"]);
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);

    // state captured at flush → injected into the next request.
    expect(pipeline.store.getToolsStateId(SESSION)).toBe("state-stream");
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            tool_calls: toolChunks,
          },
        ],
        tools: TOOLS,
      },
      SESSION,
    );
    expect(lastAssistant(wire.messages)?.functions_state_id).toBe("state-stream");
  });

  test("a cancelled stream propagates upstream and does not poison the session", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    // Seed session state with a completed JSON turn.
    pipeline.jsonResponse(
      v2ToolResponse(1, [{ id: "fc-1", name: "read_file", args: { path: "src/a.ts" } }]),
      SESSION,
    );
    expect(pipeline.store.getToolsStateId(SESSION)).toBe("state-1");

    // Mid-stream abort: the source stays open so the cancel is observable.
    let upstreamCancels = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame("response.message.delta", { messages: [{ content: [{ text: "partial" }] }] }),
          ),
        );
      },
      cancel() {
        upstreamCancels += 1;
      },
    });

    const out = pipeline.streamingResponse(new Response(source), SESSION);
    const reader = bodyReader(out);
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel("client-abort");
    expect(upstreamCancels).toBe(1);

    // The session is still usable and its state is intact.
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
        ],
        tools: TOOLS,
      },
      SESSION,
    );
    expect(lastAssistant(wire.messages)?.functions_state_id).toBe("state-1");
  });
});
