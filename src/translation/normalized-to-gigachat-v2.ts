/**
 * Normalized model → GigaChat V2 request (agents.md RULE 13: no silent
 * translation; unsupported values raise controlled errors instead of guesses).
 *
 * Key points per the official spec (docs/external/gigachat-api.yml):
 * - content items are keyed objects WITHOUT a `type` discriminator;
 * - `function_call.arguments` is a JSON **string**;
 * - tool results map to `function_result {name, result}`;
 * - `tool_choice none|auto|forced` maps to `tool_config.mode`;
 * - request tool state maps to `tool_state_id`.
 */
import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  ToolResultPart,
} from "../core/types";
import { toV2BuiltinTool } from "../gigachat/v2/tools/builtin";
import { toCustomFunction } from "../gigachat/v2/tools/function";
import { type ToolResultRef, verifyToolLinkage } from "../gigachat/v2/tools/parallel";
import type {
  ChatCompletionV2Request,
  CustomFunction,
  ModelOptions,
  ToolConfig,
  V2Message,
  V2Tool,
} from "../gigachat/v2/types";

export function normalizedToGigaChatV2(norm: NormalizedRequest): ChatCompletionV2Request {
  if (!norm.model) {
    throw new Error(
      "V2 request requires `model` (OpenAI body omitted it); refusing to guess a default model",
    );
  }
  const request: ChatCompletionV2Request = {
    model: norm.model,
    messages: norm.messages.map((m, index) => toV2Message(m, norm.messages.slice(0, index))),
  };
  const modelOptions = toModelOptions(norm);
  if (modelOptions) request.model_options = modelOptions;
  if (norm.stream !== undefined) request.stream = norm.stream;
  const toolConfig = toToolConfig(norm);
  if (toolConfig) request.tool_config = toolConfig;
  const tools = toV2Tools(norm.tools);
  if (tools) request.tools = tools;
  return request;
}

function toV2Message(m: NormalizedMessage, priorMessages: NormalizedMessage[]): V2Message {
  const v2: V2Message = { role: m.role, content: [] };
  if (m.stateId) v2.tool_state_id = m.stateId;
  // Tool identity invariant (plan §10): tool_1 → result_1. Resolve and verify
  // all tool results of this message against prior assistant calls BEFORE
  // emitting content, so orphan/duplicate results fail as controlled errors.
  const results: Array<ToolResultPart & { index: number }> = [];
  for (const part of m.content) {
    if (part.type === "tool_result") results.push({ ...part, index: results.length });
  }
  const priorCalls = priorMessages.flatMap((pm) => pm.toolCalls ?? []);
  const linkage = verifyToolLinkage(
    priorCalls,
    results.map((r): ToolResultRef => ({ index: r.index, toolCallId: r.toolCallId, name: r.name })),
  );
  for (const orphan of linkage.orphanResults) {
    throw new Error(
      orphan.toolCallId !== undefined
        ? `tool result without a resolvable function name (tool_call_id=${orphan.toolCallId})`
        : `tool result without a tool_call_id or name (index ${orphan.index})`,
    );
  }
  for (const dup of linkage.duplicateResults) {
    throw new Error(
      `duplicate tool result for call ${dup.toolCallId ?? "<none>"} ` +
        "(tool_1 → result_2 is forbidden)",
    );
  }
  const linkedNames = linkage.linked.map((l) => l.name);
  let resultIndex = 0;
  for (const part of m.content) {
    switch (part.type) {
      case "text":
        v2.content.push({ text: part.text });
        break;
      case "file":
        v2.content.push({ files: [{ id: part.id }] });
        break;
      case "image":
        // V2 has no image content part in the spec. Direct image content is
        // out of scope until PHASE 6 (file upload / inline_data mapping).
        throw new Error(
          "image content part cannot map to V2 yet (PHASE 6: file upload / inline_data mapping)",
        );
      case "tool_result": {
        const linked = linkedNames[resultIndex];
        resultIndex += 1;
        if (linked === undefined) {
          // Unreachable while verifyToolLinkage passes; defensive controlled
          // error instead of a silent empty name.
          throw new Error("internal: tool_result without resolved linkage");
        }
        v2.content.push({ function_result: { name: linked, result: part.result } });
        break;
      }
    }
  }
  for (const call of m.toolCalls ?? []) {
    v2.content.push({
      function_call: { name: call.name, arguments: stringifyArguments(call.arguments) },
    });
  }
  return v2;
}

function stringifyArguments(args: Record<string, unknown> | undefined): string {
  return JSON.stringify(args ?? {});
}

function toModelOptions(norm: NormalizedRequest): ModelOptions | undefined {
  const opts: ModelOptions = {};
  if (norm.temperature !== undefined) opts.temperature = norm.temperature;
  if (norm.topP !== undefined) opts.top_p = norm.topP;
  if (norm.maxTokens !== undefined) opts.max_tokens = norm.maxTokens;
  if (norm.repetitionPenalty !== undefined) {
    opts.repetition_penalty = norm.repetitionPenalty;
  }
  if (norm.responseFormat) {
    const fmt = norm.responseFormat;
    if (fmt.type === "json_schema") {
      opts.response_format = {
        type: "json_schema",
        ...(fmt.schema !== undefined ? { schema: fmt.schema } : {}),
        ...(fmt.strict !== undefined ? { strict: fmt.strict } : {}),
      };
    } else if (fmt.type === "json_object") {
      opts.response_format = { type: "json" };
    }
  }
  // Not representable in V2 model_options (documented in the compatibility
  // matrix): `stop` (no stop-token list in V2) and reasoning controls.
  return Object.keys(opts).length > 0 ? opts : undefined;
}

function toToolConfig(norm: NormalizedRequest): ToolConfig | undefined {
  const choice = norm.toolChoice;
  if (choice === "none") return { mode: "none" };
  if (choice !== null && typeof choice === "object") {
    return { mode: "forced", function_name: choice.functionName };
  }
  // auto is the V2 default whenever tools are declared; make it explicit.
  if (choice === "auto" || (norm.tools?.length ?? 0) > 0) return { mode: "auto" };
  return undefined;
}

function toV2Tools(tools: NormalizedTool[] | undefined): V2Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const specifications: CustomFunction[] = [];
  const builtins: V2Tool[] = [];
  for (const tool of tools) {
    if (tool.builtin !== undefined) {
      // Builtin tool ids are interpreted at the boundary only.
      builtins.push(toV2BuiltinTool(tool.builtin));
      continue;
    }
    specifications.push(toCustomFunction(tool));
  }
  const out: V2Tool[] = [];
  if (specifications.length > 0) out.push({ functions: { specifications } });
  out.push(...builtins);
  return out;
}
