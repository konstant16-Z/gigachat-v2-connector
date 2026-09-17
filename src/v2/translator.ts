/**
 * translateOpenAiToGigaChat — converts an OpenAI-compatible request body into
 * a GigaChat request body.
 *
 * Includes the multi-tool-call fix: when an assistant message carries several
 * tool_calls, the old bundle kept only the first one and every later result
 * became an orphan ("every assistant function result must have an assistant
 * function in history"). Here the extra calls are stashed in `pendingCalls`
 * and re-emitted as interleaved (assistant function_call + function result)
 * pairs, one per call id, right before their matching result messages.
 *
 * History shape expected by GigaChat:
 *   user
 *   assistant { function_call }
 *   function  { name, content }
 *   assistant { function_call }   <- second (and further) parallel call
 *   function  { name, content }
 */
import axios from "axios";
import FormData from "form-data";
import { v4 } from "uuid";
import { assertUploadSize, base64DecodedBytes } from "../core/attachments.js";
import { GIGACHAT_FILES_URL, log, error } from "./constants.js";
import { getHttpsAgent, sanitizeError } from "./net.js";
import { getToolAlias } from "./toolRegistry.js";
import { parseArgumentsToObject, sanitizeFunctionParameters } from "../utils/converter.js";
import type {
  OpenAiChatBody,
  OpenAiMessage,
  GigaChatMessage,
  GigaChatRequestBody
} from "../types/gigachat.js";

const HIGH_REASONING_PROMPT = `
[Системное руководство: Проанализируй задачу очень подробно, составь детальный пошаговый план решения и проведи глубокие рассуждения (Chain-of-Thought) перед тем, как выдать финальный ответ.]`;
const MEDIUM_REASONING_PROMPT = `
[Системное руководство: Подумай пошагово перед тем, как выдать итоговый ответ.]`;

/**
 * Upload a base64 data-URL image to GigaChat files and return the file id.
 */
async function uploadBase64File(
  base64DataUrl: string,
  token: string,
  verifySsl: boolean,
  caBundle: string
): Promise<string> {
  const matches = base64DataUrl.match(/^data:([A-Za-z0-9\-+./]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error("Invalid base64 data URL format");
  }
  const mimeType = matches[1];
  const dataString = matches[2];
  if (!mimeType || !dataString) {
    throw new Error("Invalid base64 data URL parts");
  }
  // Enforce the documented per-attachment limit before decoding (plan §31).
  assertUploadSize(mimeType, base64DecodedBytes(dataString));
  const buffer = Buffer.from(dataString, "base64");
  let ext = "png";
  if (mimeType.includes("jpeg")) ext = "jpg";
  else if (mimeType.includes("webp")) ext = "webp";
  const tempFileName = `upload_${Date.now()}.${ext}`;
  const form = new FormData();
  form.append("file", buffer, {
    filename: tempFileName,
    contentType: mimeType
  });
  form.append("purpose", "general");
  const headers = {
    ...form.getHeaders(),
    Authorization: `Bearer ${token}`,
    RqUID: v4()
  };
  const httpsAgent = getHttpsAgent(verifySsl, caBundle);
  try {
    const response = await axios.post(GIGACHAT_FILES_URL, form, {
      headers,
      httpsAgent,
      timeout: 30000
    });
    return response.data.id;
  } catch (err) {
    throw sanitizeError(err);
  }
}

export async function translateOpenAiToGigaChat(
  openAiBody: OpenAiChatBody,
  token: string,
  verifySsl: boolean,
  caBundle: string
): Promise<GigaChatRequestBody> {
  let modelName = openAiBody.model || "GigaChat-Max";
  if (modelName === "GigaChat-2-Lite") {
    modelName = "GigaChat-2";
  }
  const gigaBody: GigaChatRequestBody = {
    model: modelName,
    messages: [],
    stream: !!openAiBody.stream,
    temperature: openAiBody.temperature ?? 0.7,
    top_p: openAiBody.top_p ?? 1,
    max_tokens: openAiBody.max_tokens ?? 1024
  };

  // --- Reasoning level -> Chain-of-Thought system prompt -------------------
  let reasoningLevel: string | null = null;
  if (openAiBody.reasoning_effort) {
    reasoningLevel = openAiBody.reasoning_effort.toLowerCase();
  } else if (openAiBody.thinking && typeof openAiBody.thinking === "object") {
    reasoningLevel = (openAiBody.thinking.budget_tokens ?? 0) > 1024 ? "high" : "medium";
  }
  const cotPrompt =
    reasoningLevel === "high" ? HIGH_REASONING_PROMPT : reasoningLevel === "medium" ? MEDIUM_REASONING_PROMPT : "";

  // --- Split system messages out of the flow -------------------------------
  const systemMessages: OpenAiMessage[] = [];
  const nonSystemMessages: OpenAiMessage[] = [];
  for (const msg of openAiBody.messages || []) {
    if (msg.role === "system" || msg.role === "developer") {
      systemMessages.push(msg);
    } else {
      nonSystemMessages.push(msg);
    }
  }

  let systemContent = "";
  for (const sysMsg of systemMessages) {
    if (typeof sysMsg.content === "string") {
      if (systemContent) systemContent += "\n";
      systemContent += sysMsg.content;
    } else if (Array.isArray(sysMsg.content)) {
      for (const part of sysMsg.content) {
        if (part.type === "text" && typeof part.text === "string") {
          if (systemContent) systemContent += "\n";
          systemContent += part.text;
        }
      }
    }
  }
  if (cotPrompt) {
    if (systemContent) {
      systemContent += cotPrompt;
    } else {
      systemContent = cotPrompt.trim();
    }
  }

  const gigaMessages: GigaChatMessage[] = [];
  if (systemContent) {
    gigaMessages.push({
      role: "system",
      content: systemContent
    });
  }

  // --- Pre-index tool_call ids -> names (for function result names) --------
  const toolCallIdToName = new Map<string, string>();
  for (const msg of nonSystemMessages) {
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) {
          toolCallIdToName.set(tc.id, tc.function.name);
        }
      }
    }
  }

  // --- Single-message translator ------------------------------------------
  const pendingCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }> = [];
  const translateOneMessage = async (msg: OpenAiMessage): Promise<GigaChatMessage> => {
    const gigaMsg: GigaChatMessage = { role: msg.role };
    const hasFunctionCall = !!(
      (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ||
      msg.function_call
    );
    if (msg.role === "tool" || msg.role === "function") {
      let contentStr: string;
      if (msg.content === null || msg.content === undefined) {
        contentStr = "{}";
      } else if (typeof msg.content === "string") {
        try {
          JSON.parse(msg.content);
          contentStr = msg.content;
        } catch {
          contentStr = JSON.stringify(msg.content);
        }
      } else {
        contentStr = JSON.stringify(msg.content);
      }
      gigaMsg.content = contentStr;
    } else if (
      msg.content === null ||
      msg.content === undefined ||
      (msg.content === "" && hasFunctionCall)
    ) {
      gigaMsg.content = hasFunctionCall ? null : "";
    } else if (typeof msg.content === "string") {
      gigaMsg.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      let textContent = "";
      const attachments: string[] = [];
      for (const part of msg.content) {
        if (part.type === "text" && typeof part.text === "string") {
          if (textContent) textContent += "\n";
          textContent += part.text;
        } else if (part.type === "image_url") {
          const urlStr = part.image_url?.url || "";
          if (urlStr.startsWith("data:image/")) {
            try {
              log("Intercepted base64 image. Uploading to GigaChat files...");
              const fileId = await uploadBase64File(urlStr, token, verifySsl, caBundle);
              attachments.push(fileId);
            } catch (err) {
              error("Failed to upload message image:", err instanceof Error ? err.message : String(err));
              if (textContent) textContent += "\n";
              textContent += "[Image Upload Failed]";
            }
          } else {
            if (textContent) textContent += "\n";
            textContent += `[Image URL: ${urlStr}]`;
          }
        }
      }
      gigaMsg.content = textContent || (hasFunctionCall ? null : "");
      if (attachments.length > 0) {
        gigaMsg.attachments = attachments;
      }
    } else {
      gigaMsg.content = hasFunctionCall ? null : "";
    }
    if (msg.role === "tool") {
      gigaMsg.role = "function";
    }
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      gigaMsg.function_call = {
        name: getToolAlias(msg.tool_calls[0].function?.name),
        arguments: parseArgumentsToObject(msg.tool_calls[0].function?.arguments)
      };
    } else if (msg.function_call) {
      gigaMsg.function_call = {
        name: getToolAlias(msg.function_call.name),
        arguments: parseArgumentsToObject(msg.function_call.arguments)
      };
    }
    if (msg.functions_state_id) {
      gigaMsg.functions_state_id = msg.functions_state_id;
    }
    if (msg.role === "tool" || msg.role === "function") {
      const resolvedName =
        msg.name || (msg.tool_call_id ? toolCallIdToName.get(msg.tool_call_id) : undefined);
      if (resolvedName) {
        gigaMsg.name = getToolAlias(resolvedName);
      }
    } else if (msg.name) {
      gigaMsg.name = getToolAlias(msg.name);
    }
    return gigaMsg;
  };

  // --- Message loop with parallel tool-call pairing -----------------------
  for (const msg of nonSystemMessages) {
    const isResult = msg.role === "tool" || msg.role === "function";
    const calls = msg.tool_calls && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!isResult && calls.length > 1) {
      // Assistant sent N>1 tool calls at once: keep the first as the message's
      // function_call and remember the rest, to be interleaved before results.
      const anchors = calls.map((tc) => ({
        id: tc.id,
        name: getToolAlias(tc.function?.name),
        args: parseArgumentsToObject(tc.function?.arguments)
      }));
      const first = anchors.shift();
      const firstMsg = await translateOneMessage({ ...msg, tool_calls: calls.slice(0, 1) });
      if (first && !firstMsg.function_call) {
        firstMsg.function_call = { name: first.name, arguments: first.args };
      }
      gigaMessages.push(firstMsg);
      for (const a of anchors) {
        pendingCalls.push(a);
      }
      continue;
    }
    if (isResult && pendingCalls.length > 0) {
      const resultRep = msg.tool_call_id || msg.name;
      const idx = pendingCalls.findIndex((p) => p.id === resultRep || p.name === resultRep);
      if (idx >= 0) {
        const anchor = pendingCalls.splice(idx, 1)[0];
        gigaMessages.push({
          role: "assistant",
          content: null,
          function_call: { name: anchor.name, arguments: anchor.args }
        });
        gigaMessages.push(await translateOneMessage(msg));
        continue;
      }
    }
    gigaMessages.push(await translateOneMessage(msg));
  }

  gigaBody.messages = gigaMessages;

  // --- Tools / functions declaration ---------------------------------------
  const hasTools =
    (openAiBody.tools && Array.isArray(openAiBody.tools) && openAiBody.tools.length > 0) ||
    (openAiBody.functions && Array.isArray(openAiBody.functions) && openAiBody.functions.length > 0);

  if (openAiBody.tools && Array.isArray(openAiBody.tools)) {
    gigaBody.functions = openAiBody.tools.map((t) => ({
      name: getToolAlias(t.function?.name),
      description: t.function?.description || "",
      parameters: sanitizeFunctionParameters(t.function?.parameters) || { type: "object", properties: {} }
    }));
    if (typeof openAiBody.tool_choice === "string") {
      if (openAiBody.tool_choice === "none") {
        gigaBody.function_call = "none";
      } else if (openAiBody.tool_choice === "required") {
        gigaBody.function_call = "auto";
      } else {
        gigaBody.function_call = openAiBody.tool_choice;
      }
    } else if (openAiBody.tool_choice && typeof openAiBody.tool_choice === "object") {
      if (openAiBody.tool_choice.function?.name) {
        gigaBody.function_call = {
          name: getToolAlias(openAiBody.tool_choice.function.name)
        };
      } else {
        gigaBody.function_call = "auto";
      }
    } else {
      gigaBody.function_call = "auto";
    }
  } else if (openAiBody.functions && Array.isArray(openAiBody.functions)) {
    gigaBody.functions = openAiBody.functions.map((f) => ({
      name: getToolAlias(f.name),
      description: f.description || "",
      parameters: sanitizeFunctionParameters(f.parameters) || { type: "object", properties: {} }
    }));
    if (openAiBody.function_call) {
      if (typeof openAiBody.function_call === "string") {
        gigaBody.function_call = openAiBody.function_call;
      } else if (typeof openAiBody.function_call === "object") {
        gigaBody.function_call = {
          name: getToolAlias(openAiBody.function_call.name)
        };
      }
    }
  }

  // --- Response format ------------------------------------------------------
  if (openAiBody.response_format && !hasTools) {
    if (openAiBody.response_format.type === "json_object") {
      gigaBody.response_format = { type: "json" };
    } else if (openAiBody.response_format.type === "json_schema") {
      const openAiSchema = openAiBody.response_format.json_schema?.schema;
      if (openAiSchema) {
        gigaBody.response_format = {
          type: "json_schema",
          schema: sanitizeFunctionParameters(openAiSchema),
          strict:
            openAiBody.response_format.json_schema?.strict !== undefined
              ? !!openAiBody.response_format.json_schema.strict
              : undefined
        };
      } else {
        gigaBody.response_format = { type: "json" };
      }
    }
  }

  // --- Extra sampling options -----------------------------------------------
  if (openAiBody.stop) {
    gigaBody.stop = openAiBody.stop;
  }
  if (openAiBody.repetition_penalty) {
    gigaBody.repetition_penalty = openAiBody.repetition_penalty;
  }

  return gigaBody;
}