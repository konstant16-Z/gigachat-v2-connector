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
import type {
  ChatCompletionV2Request,
  CustomFunction,
  FunctionCallArgs,
  ModelOptions,
  ToolConfig,
  V2ContentItem,
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
    messages: norm.messages.map(
      (m, index) => toV2Message(m, norm.messages.slice(0, index)),
    ),
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

function toV2Message(
  m: NormalizedMessage,
  priorMessages: NormalizedMessage[],
): V2Message {
  const v2: V2Message = { role: m.role, content: [] };
  if (m.stateId) v2.tool_state_id = m.stateId;
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
      case "tool_result":
        v2.content.push(toFunctionResult(part, priorMessages));
        break;
    }
  }
  for (const call of m.toolCalls ?? []) {
    v2.content.push({ function_call: toFunctionCallArgs(call.name, call.arguments) });
  }
  return v2;
}

/** name is required by `function_result`; resolve it from prior tool calls. */
function toFunctionResult(
  part: ToolResultPart,
  priorMessages: NormalizedMessage[],
): V2ContentItem {
  const name = part.name ?? resolveToolName(part.toolCallId, priorMessages);
  if (!name) {
    throw new Error(
      `tool result without a resolvable function name (tool_call_id=${part.toolCallId ?? "<none>"})`,
    );
  }
  return { function_result: { name, result: part.result } };
}

function resolveToolName(
  toolCallId: string | undefined,
  priorMessages: NormalizedMessage[],
): string | undefined {
  if (!toolCallId) return undefined;
  for (const m of priorMessages) {
    for (const call of m.toolCalls ?? []) {
      if (call.id === toolCallId) return call.name;
    }
  }
  return undefined;
}

function toFunctionCallArgs(
  name: string,
  args: Record<string, unknown> | undefined,
): FunctionCallArgs {
  return { name, arguments: JSON.stringify(args ?? {}) };
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
      if (tool.builtin === "image_generate") builtins.push({ image_generate: {} });
      else if (tool.builtin === "model_3d_generate") builtins.push({ model_3d_generate: {} });
      else {
        throw new Error(
          `unknown builtin tool "${tool.builtin}" (image_generate|model_3d_generate expected)`,
        );
      }
      continue;
    }
    const fn: CustomFunction = { name: tool.name };
    if (tool.description !== undefined) fn.description = tool.description;
    if (tool.parameters !== undefined) {
      fn.parameters = tool.parameters as Record<string, unknown>;
    }
    if (tool.fewShotExamples !== undefined) fn.few_shot_examples = tool.fewShotExamples;
    if (tool.returnParameters !== undefined) {
      fn.return_parameters = tool.returnParameters as Record<string, unknown>;
    }
    specifications.push(fn);
  }
  const out: V2Tool[] = [];
  if (specifications.length > 0) out.push({ functions: { specifications } });
  out.push(...builtins);
  return out;
}