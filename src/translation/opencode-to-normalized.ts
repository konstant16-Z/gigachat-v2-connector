/**
 * OpenAI-compatible request → normalized model (agents.md RULE 13: no silent
 * translation; unsupported values raise controlled errors instead of guesses).
 */
import type { OpenAiChatBody, OpenAiMessage } from "../types/gigachat";
import type {
  NormalizedContentPart,
  NormalizedMessage,
  NormalizedReasoning,
  NormalizedRequest,
  NormalizedResponseFormat,
  NormalizedRole,
  NormalizedTool,
  NormalizedToolCall,
  NormalizedToolChoice,
} from "../core/types";
import { parseToolArguments } from "./utils";

export function openCodeToNormalized(body: OpenAiChatBody): NormalizedRequest {
  return {
    model: body.model === "" ? undefined : body.model,
    messages: (body.messages ?? []).map(toNormalizedMessage),
    tools: mergeTools(body.tools, body.functions),
    toolChoice: toNormalizedToolChoice(body.tool_choice),
    reasoning: toNormalizedReasoning(body.reasoning_effort, body.thinking),
    responseFormat: toNormalizedResponseFormat(body.response_format),
    stream: body.stream,
    temperature: body.temperature,
    topP: body.top_p,
    maxTokens: body.max_tokens,
    stop: body.stop,
    repetitionPenalty: body.repetition_penalty,
  };
}

function toNormalizedRole(role: OpenAiMessage["role"]): NormalizedRole {
  switch (role) {
    case "system":
    case "assistant":
    case "user":
    case "tool":
      return role;
    case "function":
      // Legacy OpenAI tool results are represented as tool results in V2 too.
      return "tool";
    case "developer":
      // Documented decision: OpenCode has no developer role and V2 has no
      // developer role either (spec: user|system|assistant|tool).
      return "system";
  }
}

function toNormalizedMessage(msg: OpenAiMessage): NormalizedMessage {
  const normalized: NormalizedMessage = {
    role: toNormalizedRole(msg.role),
    content: toContentParts(msg),
  };
  const toolCalls = toNormalizedToolCalls(msg);
  if (toolCalls.length > 0) normalized.toolCalls = toolCalls;
  if (msg.tool_call_id !== undefined) normalized.toolCallId = msg.tool_call_id;
  // V1-compatible state token forwarded verbatim → opaque neutral stateId.
  if (msg.functions_state_id !== undefined) normalized.stateId = msg.functions_state_id;
  return normalized;
}

function toContentParts(msg: OpenAiMessage): NormalizedContentPart[] {
  // Tool/function messages carry the tool result as their content.
  if (msg.role === "tool" || msg.role === "function") {
    const text = toPlainText(msg.content);
    return text === null
      ? []
      : [{ type: "tool_result", toolCallId: msg.tool_call_id, result: text }];
  }
  if (typeof msg.content === "string") {
    return msg.content.length > 0 ? [{ type: "text", text: msg.content }] : [];
  }
  if (Array.isArray(msg.content)) {
    const parts: NormalizedContentPart[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "image_url") {
        parts.push({
          type: "image",
          url: part.image_url.url,
          detail: part.image_url.detail,
        });
      }
    }
    return parts;
  }
  return [];
}

function toPlainText(content: OpenAiMessage["content"]): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

function toNormalizedToolCalls(msg: OpenAiMessage): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];
  for (const tc of msg.tool_calls ?? []) {
    calls.push({
      // Preserve the provider id so tool results stay linked to their calls.
      id: tc.id ?? crypto.randomUUID(),
      name: tc.function.name,
      arguments: parseToolArguments(tc.function.arguments),
    });
  }
  // Legacy single function_call (deprecated OpenAI field) → one tool call.
  if (msg.function_call !== undefined) {
    calls.push({
      id: crypto.randomUUID(), // legacy field has no id (documented)
      name: msg.function_call.name ?? "",
      arguments: parseToolArguments(msg.function_call.arguments),
    });
  }
  return calls;
}

function mergeTools(
  tools: OpenAiChatBody["tools"],
  functions: OpenAiChatBody["functions"],
): NormalizedTool[] | undefined {
  const out: NormalizedTool[] = [];
  for (const t of tools ?? []) {
    out.push({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    });
  }
  for (const f of functions ?? []) {
    out.push({ name: f.name, description: f.description, parameters: f.parameters });
  }
  return out.length > 0 ? out : undefined;
}

function toNormalizedToolChoice(
  choice: OpenAiChatBody["tool_choice"],
): NormalizedToolChoice | null | undefined {
  if (choice === undefined) return undefined;
  if (choice === "none" || choice === "auto") return choice;
  if (choice === "required") {
    throw new Error(
      `unsupported tool_choice "required": V2 tool_config supports auto|none|forced`,
    );
  }
  if (typeof choice === "object") {
    const name = choice.function?.name;
    if (!name) throw new Error("tool_choice object requires function.name");
    return { functionName: name };
  }
  throw new Error(`unsupported tool_choice ${JSON.stringify(choice)}`);
}

function toNormalizedReasoning(
  effort: OpenAiChatBody["reasoning_effort"],
  thinking: OpenAiChatBody["thinking"],
): NormalizedReasoning | null | undefined {
  if (effort !== undefined) {
    if (effort === "low" || effort === "medium" || effort === "high") {
      return { effort };
    }
    throw new Error(`unsupported reasoning_effort "${effort}" (low|medium|high expected)`);
  }
  if (thinking !== undefined) {
    return { think: { budgetTokens: thinking.budget_tokens } };
  }
  return undefined;
}

function toNormalizedResponseFormat(
  fmt: OpenAiChatBody["response_format"],
): NormalizedResponseFormat | null | undefined {
  if (fmt === undefined) return undefined;
  switch (fmt.type) {
    case "text":
      return { type: "text" };
    case "json":
    case "json_object":
      return { type: "json_object" };
    case "json_schema":
      return {
        type: "json_schema",
        schema: fmt.json_schema?.schema,
        strict: fmt.json_schema?.strict,
      };
    default:
      throw new Error(`unsupported response_format type "${fmt.type}"`);
  }
}