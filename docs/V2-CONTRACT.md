# GigaChat API V2 Contract (Official)

Source: https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-chat-v-2
OpenAPI spec: gigachat-api.yml (cleaned)

## Endpoint
- **URL**: `POST /v2/chat/completions`
- **Server**: `https://api.giga.chat` (also accepts `https://ngw.devices.sberbank.ru:9443` for OAuth, but chat endpoint is at api.giga.chat)
- **Auth**: Bearer token from `POST /api/v2/oauth` (Basic auth with credentials)

## Request: ChatCompletionV2Request
```json
{
  "model": "string (required)",
  "messages": [
    {
      "role": "user|system|assistant|tool (required)",
      "tool_state_id": "string (UUIDv4, optional)",
      "content": [
        {
          "inline_data": { /* additional context, e.g. sources */ },
          "text": "string",
          "files": [ { "id": "string (required)" } ],
          "function_result": {
            "name": "string (required)",
            "result": "string (JSON stringified)"   // wrapped in string
          },
          "function_call": {                         // same as FunctionCallArgs
            "name": "string",
            "arguments": "string (JSON stringified)"
          }
        }
      ]
    }
  ],
  "model_options": {                                 // V2 replacement for V1 top-level fields
    "temperature": "number (0, ∞)",
    "top_p": "number [0,1]",
    "max_tokens": "integer >0",
    "repetition_penalty": "number",
    "update_interval": "number (seconds, stream only)",
    "unnormalized_history": "boolean",
    "top_logprobs": "integer [1,5]",
    "response_format": {                             // replaces V1 response_format
      "type": "json|json_schema",
      "schema": "any",
      "strict": "boolean?"
    }
  },
  "stream": "boolean (default false)",
  "disable_filter": "boolean",
  "ranker_options": {                                // tools ranking
    "enabled": "boolean",
    "top_n": "integer",
    "embeddings_model": "string"
  },
  "user_info": {
    "timezone": "string (IANA)"
  },
  "tool_config": {                                   // tool invocation mode
    "mode": "auto|none|forced (required)",
    "tool_name": "string",                           // for built-in tools: image_generate, model_3d_generate
    "function_name": "string"                        // for user functions
  },
  "tools": [                                         // array of oneOf
    {                                                // user-defined functions
      "functions": {
        "specifications": [
          {
            "name": "string",
            "description": "string",
            "parameters": { /* JSON Schema */ },
            "few_shot_examples": [
              { "request": "string", "params": { /* args */ } }
            ],
            "return_parameters": { /* JSON Schema */ }
          }
        ]
      }
    },
    {                                                // built-in: image generation
      "image_generate": {}
    },
    {                                                // built-in: 3D model generation
      "model_3d_generate": {}
    }
  ]
}
```

## Response: ChatCompletionV2Response
```json
{
  "model": "string",
  "thread_id": "string?",
  "created_at": "unix timestamp",
  "messages": [
    {
      "message_id": "string?",
      "role": "user|system|assistant|tool",
      "tools_state_id": "string (UUIDv4)?",
      "content": [
        {
          "text": "string",
          "files": [ { "target": "image|audio|3dmodel", "id": "string", "mime": "string" } ],
          "function_call": {                         // same as FunctionCallArgs
            "name": "string",
            "arguments": "string (JSON stringified)"
          },
          "tool_execution": {                        // built-in tool result
            "name": "string (e.g. image_generation)",
            "status": "success|fail",
            "seconds_left": "integer?",
            "censored": "boolean?"
          },
          "logprobs": [ { "chosen": {...}, "top": [...] } ],
          "inline_data": { "sources": {...}, "images": [...] }
        }
      ]
    }
  ],
  "finish_reason": "stop|length|function_call|function_call_error|blacklist|request_blacklist|request_whitelist|request_filter|response_blacklist",
  "usage": {
    "input_tokens": "integer",
    "input_tokens_details": { "cached_tokens": "integer" },
    "output_tokens": "integer",
    "total_tokens": "integer"
  },
  "additional_data": {
    "execution_steps": [                             // detailed steps (function calls, tool usage)
      {
        "ts_start": "integer",
        "ts_end": "integer",
        "event_type": "string",
        "step": {
          "function_call": {
            "name": "string",
            "arguments": "string (JSON stringified)"
          },
          "functions_in": ["string"],
          "functions_out": ["string"],
          "function_executed": "string",
          "function_result": "success|fail"
        }
      }
    ]
  }
}
```

## Streaming (SSE)
- **Content-Type**: `text/event-stream`
- **Event types**:
  - `response.message.delta` — delta of assistant message (can include text, files, function_call, tool_execution, logprobs, inline_data)
  - `response.message.done` — final message; contains `finish_reason` and aggregated `usage`
  - `response.tool.in_progress` — tool execution started
  - `response.tool.completed` — tool execution completed (with status)
- **No** `[DONE]` event; stream ends after `response.message.done`.

## Key differences from V1 (used in current connector)
| Aspect | V1 (current) | V2 (official) |
|---|---|---|
| **Endpoint** | `/api/v1/chat/completions` | `/v2/chat/completions` |
| **Model aliases** | `GigaChat-2-Lite` → `GigaChat-2` | direct model names (e.g. `GigaChat-2-Max`, `GigaChat-3-Ultra`) |
| **Messages content** | `string` or `Array<{type:"text",text:string}> ` | `Array<parts>` where parts can be text, files, function_result, function_call, inline_data |
| **Tool declaration** | `functions: Array<{name,description,parameters}>` + `function_call: "none"|"auto"|string|{name}` | `tools: Array< oneOf<FunctionsSpec, ImageGenerate, Model3DGenerate> >` + `tool_config.mode` |
| **Tool calls in request** | N/A (tool calls are only in assistant messages) | N/A (same) |
| **Tool results in request** | `tool`/`function` role with `content` as stringified JSON | `tool` role with `content` containing `function_result` (name+result) |
| **Assistant message tool calls** | `function_call: {name, arguments}` + optional `functions_state_id` | `content` containing `function_call` parts + `tools_state_id` on the message |
| **Response tool calls** | `tool_calls: [{id, type:"function", function:{name,arguments}}]` (fresh IDs) | `content` containing `function_call` parts + `tools_state_id` on the message |
| **Response built-in tools** | Not present (only function tools) | `content` containing `tool_execution` parts |
| **Streaming events** | `delta.{role,content,reasoning_content,function_call{name,arguments}}` + `[DONE]` | `response.message.delta` (structured), `response.message.done`, `response.tool.in_progress`, `response.tool.completed` |
| **Reasoning** | `reasoning_effort`/`thinking` → CoT system prompt | `model_options` (no explicit reasoning field; likely controlled via model selection) |
| **Structured output** | `response_format: {type:"json"|"json_schema",schema?,strict?}` (only if no tools) | `model_options.response_format` (same structure) |
| **File handling** | base64 → upload to `/api/v2/files` → `attachments: [file_id]` | `content.files` with `id` (presumably pre‑uploaded) |
| **Token usage** | `usage:{prompt_tokens,completion_tokens,total_tokens}` | same plus `input_tokens_details.cached_tokens` |
| **Finish reasons** | `stop|length|function_call` | extended list including blacklists, function_call_error |
| **Authentication** | unchanged (OAuth2 V2) | same |

## Notes
- `FunctionCallArgs.arguments` is a **JSON string** (spec-confirmed 2026-09-15), e.g. `'{"city":"Moscow"}'` — never an object on the wire.
- Content items are keyed objects **without** a `type` discriminator: `{text}`, `{files}`, `{function_result}`, `{function_call}`, `{inline_data}` — do not emit (or expect) `type` fields.
- Roles are limited to `user|system|assistant|tool`: there is **no** `developer` role in V2 (an incoming `developer` role maps to `system`).
- There is **no** `image` content part in the spec; image input paths (if any) must be resolved against the live API before PHASE 6.
- `tool_state_id` (on messages) replaces V1's `functions_state_id`. It is scoped to the message (assistant) and must be echoed back in subsequent requests to maintain state.
- The `functions` array inside `tools[0].functions.specifications` is the user‑defined function contract (similar to V1's `functions` but wrapped).
- Built‑in tools (`image_generate`, `model_3d_generate`) are declared via `tools` array with empty objects.
- Tool selection mode (`tool_config.mode`) determines whether the model decides (`auto`), none (`none`), or forced (`forced` with `tool_name`/`function_name`).
- Streaming now uses named events instead of raw `data:` JSON; the final event is `response.message.done` (not `[DONE]`).
- The contract explicitly separates user functions (`functions.specifications`) from built‑in tools (`image_generate`, `model_3d_generate`).

## Implications for gigachat-v2-connector
1. **Endpoint change** → update `GIGACHAT_COMPLETIONS_URL` to `https://api.giga.chat/v2/chat/completions` (or keep indirection via host mapping).
2. **Request mapping** must convert OpenAI `messages` (with optional `tool_cells`, `function_call`) into V2 `messages.content` parts, and move `tools`/`tool_choice` into `tools` + `tool_config`.
3. **Response mapping** must extract `content` parts from V2 `messages` and rebuild OpenAI `tool_calls`/`function_call` and `usage`. V2 `function_call` parts carry **no id** — ids are generated at the boundary and used for sequential linking of tool calls to results.
4. **State handling**: `tool_state_id` must be stored per conversation and fed back in assistant messages.
5. **Streaming**: replace current SSE transformer with V2 event mapping.
6. **Reasoning**: remove CoT system prompt; rely on model selection (if reasoning supported by model).
7. **Files**: adjust upload logic if needed (still likely base64 → upload → `content.files` with `id`).
8. **Tools**: keep existing `toolRegistry` aliasing but adapt to V2 structure (`tools` array + `tool_config`).
9. **Finish reasons**: map V2 enum to OpenAI `stop`/`length`/`tool_calls` (function_call → tool_calls).
10. **Usage**: passthrough `input_tokens`, `output_tokens`, `total_tokens`; optionally expose `cached_tokens`.

## Open Issues (to verify with live API)
- ~~Exact structure of `FunctionCallArgs`~~ — **CLOSED 2026-09-15**: `{name: string, arguments: string}` with `arguments` a JSON-wrapped string (official spec, gigachat-api.yml).
- Whether `files` in request expects pre‑uploaded IDs (same as V1) or supports base64 inline.
- Whether `tool_state_id` is required for all assistant messages when tools are used.
- Whether `thread_id` is needed for multi‑turn context.
- Whether `model_options` supports `reasoning` field (not present in spec).
- Whether `response_format` can be used together with `tools` (spec says in V1 it was only allowed when no tools; need to check V2).
- Spec anomaly observed in the SSE example: `finish_reason: "error"` is shown in `response.message.done` despite not being part of the enum — verify against live API.
- Spec anomaly: `created_at` is typed as `string` in some places of the spec and as integer in others — verify against live API.

---
*This document reflects the official V2 contract as of the downloaded OpenAPI spec. Any discrepancies with live API must be reported and treated as blockers (see agents.md RULE 3).*