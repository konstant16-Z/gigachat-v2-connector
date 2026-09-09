/**
 * Message/body shapes used across the translator.
 * OpenAI-compatible request in, GigaChat request out, GigaChat response
 * translated back to OpenAI-compatible response.
 */

export interface GigaChatToolCall {
  id?: string;
  index?: number;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAiMessage {
  role: "system" | "assistant" | "user" | "tool" | "function" | "developer";
  content?: string | null | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } }>;
  tool_calls?: GigaChatToolCall[];
  tool_call_id?: string;
  name?: string;
  function_call?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
  /** GigaChat-side state id forwarded verbatim when present */
  functions_state_id?: string;
}

export interface OpenAiChatBody {
  model?: string;
  messages?: OpenAiMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  repetition_penalty?: number;
  thinking?: { budget_tokens?: number };
  reasoning_effort?: string;
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: unknown; [k: string]: unknown };
  }>;
  functions?: Array<{ name: string; description?: string; parameters?: unknown }>;
  tool_choice?: string | { function?: { name?: string } };
  function_call?: string | { name?: string };
  response_format?: { type: string; json_schema?: { schema?: unknown; strict?: boolean } };
}

/** Assistant message fragment sent to GigaChat (function_call form). */
export interface GigaChatMessage {
  role: string;
  content?: string | null;
  name?: string;
  function_call?: { name: string; arguments: Record<string, unknown> };
  attachments?: string[];
  functions_state_id?: string;
}

export interface GigaChatRequestBody {
  model: string;
  messages: GigaChatMessage[];
  stream: boolean;
  temperature: number;
  top_p: number;
  max_tokens: number;
  stop?: string | string[];
  repetition_penalty?: number;
  functions?: Array<{ name: string; description: string; parameters?: unknown }>;
  function_call?: "none" | "auto" | string | { name: string };
  response_format?: { type: "json" | "json_schema"; schema?: unknown; strict?: boolean };
}

export interface GigaChatChoiceDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string;
  functions_state_id?: string;
  function_call?: { name?: string; arguments?: unknown };
  tool_calls?: GigaChatToolCall[];
}

export interface GigaChatChoice {
  index?: number;
  finish_reason?: string | null;
  delta?: GigaChatChoiceDelta;
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string;
    functions_state_id?: string;
    function_call?: { name?: string; arguments?: unknown };
    tool_calls?: GigaChatToolCall[];
  };
}

export interface GigaChatResponse {
  id?: string;
  created?: number;
  model?: string;
  choices?: GigaChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface OpenAiChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: GigaChatToolCall[];
      functions_state_id?: string;
    };
    finish_reason: string | null;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAiChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: GigaChatChoiceDelta & { content?: string; tool_calls?: GigaChatToolCall[] };
    finish_reason: string | null;
  }>;
}