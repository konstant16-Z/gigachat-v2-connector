/**
 * Normalized model → GigaChat V2 request (agents.md RULE 13: no silent
 * translation; unsupported values raise controlled errors instead of guesses).
 *
 * Key points per the official spec (docs/external/gigachat-api.yml) and live
 * API observations (docs/LIVE_API_OBSERVATIONS.md, 2026-09-15):
 * - content items are keyed objects WITHOUT a `type` discriminator;
 * - tool results map to role `function` with `function_result {name, result}`;
 * - `function_call.arguments` is an **object** on the wire (live API rejects
 *   a JSON string with 400, despite the spec typing it as string);
 * - `tool_choice none|auto|forced` maps to `tool_config.mode`;
 * - request tool state maps to `functions_state_id` (assistant message).
 */
import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  ToolResultPart,
} from "../core/types";
import { isKnownBuiltinTool, toV2BuiltinTool } from "../gigachat/v2/tools/builtin";
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
  // Live API request roles: tool results use `function`; a `tool` role is
  // rejected with 400 (spec: FunctionMessage). Other roles pass through.
  const v2: V2Message = { role: m.role === "tool" ? "function" : m.role, content: [] };
  if (m.stateId) v2.functions_state_id = m.stateId;
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
        // V2 has no image content part in the spec; images travel as uploaded
        // files (`content.files`). The V2 pipeline uploads base64 data URLs
        // upstream (`uploadDataUrlsInRequest`); only HTTP(S) URLs (or parts
        // whose upload failed and was NOT re-raised) can arrive here.
        if (part.url.startsWith("data:")) {
          throw new Error(
            "image data URL reached the V2 mapper un-uploaded; upload step failed in the pipeline (see cause above)",
          );
        }
        throw new Error(
          'HTTP(S) image URLs are not supported by GigaChat V2: convert to a base64 data URL or pre-upload via /v1/files and pass { type: "file", id }',
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
      // Live API requires arguments as an object (a JSON string → 400).
      function_call: { name: call.name, arguments: call.arguments ?? {} },
    });
  }
  return v2;
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
    switch (fmt.type) {
      case "text":
        // Explicit text is the V2 default; emit it so the request is not
        // silently altered (agents.md RULE 13).
        opts.response_format = { type: "text" };
        break;
      case "json_object":
        // LIVE 2026-09-16: `{"type":"json"}` and `{"type":"json_object"}`
        // are both rejected (400 "Unknown type ... in response_format"); V2
        // accepts only text | json_schema. Raising a controlled error instead
        // of guessing or silently degrading (§13, agents.md RULE 13).
        throw new Error(
          'response_format "json_object" is not representable in V2 (live API rejects ' +
            '"json"/"json_object"; use json_schema with a schema)',
        );
      case "json_schema":
        if (fmt.schema === undefined) {
          // LIVE 2026-09-16: `json_schema` without `schema` → 400 "Empty
          // schema with json format type is not supported".
          throw new Error(
            'response_format "json_schema" requires a schema (live API: "Empty schema ' +
              'with json format type is not supported")',
          );
        }
        opts.response_format = {
          type: "json_schema",
          schema: fmt.schema,
          ...(fmt.strict !== undefined ? { strict: fmt.strict } : {}),
        };
        break;
    }
  }
  // Not representable in V2 model_options (documented in the compatibility
  // matrix and live observations): `stop` (no stop-token list in V2),
  // reasoning controls (V2 has no reasoning field; model choice controls it),
  // and json_object → json_schema replacement (live API rejects json/json_object).
  return Object.keys(opts).length > 0 ? opts : undefined;
}

function toToolConfig(norm: NormalizedRequest): ToolConfig | undefined {
  const choice = norm.toolChoice;
  if (choice === "none") return { mode: "none" };
  if (choice !== null && typeof choice === "object") {
    const name = choice.functionName;
    // Builtin tools are forced via `tool_name`; custom functions via
    // `function_name` (spec: tool_config.tool_name / function_name).
    return isKnownBuiltinTool(name)
      ? { mode: "forced", tool_name: name }
      : { mode: "forced", function_name: name };
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
