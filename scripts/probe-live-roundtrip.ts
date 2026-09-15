#!/usr/bin/env bun
/**
 * End-to-end live round-trip through the FIXED mapping layer (2026-09-15).
 *
 *   1. OpenAI-style body → openCodeToNormalized → normalizedToGigaChatV2 → POST
 *      (proving the request mapper emits role "function" + object arguments
 *       + functions_state_id the live API accepts)
 *   2. live response → gigachatV2ToNormalized → print normalized tool call,
 *      id, stateId (proving tool_state_id / function_call.id / object args)
 *   3. second turn rebuilt from the normalized response (stateId + toolCalls)
 *      + function result → normalizedToGigaChatV2 → POST → expect 200 stop
 *
 * Credentials are read from GIGACHAT_CREDENTIALS env or the local OpenCode
 * config; never printed. Run from the repo root:
 *   bun run scripts/probe-live-roundtrip.ts
 */
import axios, { AxiosError } from "axios";
import * as os from "node:os";
import * as path from "node:path";
import type { NormalizedRequest } from "../src/core/types";
import type { ChatCompletionV2Response } from "../src/gigachat/v2/types";
import { gigachatV2ToNormalized } from "../src/translation/gigachat-v2-to-normalized";
import { normalizedToGigaChatV2 } from "../src/translation/normalized-to-gigachat-v2";
import { openCodeToNormalized } from "../src/translation/opencode-to-normalized";
import { authManager } from "../src/v2/auth";
import { DEFAULT_CA_BUNDLE_FILE } from "../src/v2/constants";
import { getHttpsAgent, shouldVerifySsl } from "../src/v2/net";
import type { OpenAiChatBody } from "../src/types/gigachat";

const BASE = "https://api.giga.chat/v2/chat/completions";
const MODEL = "GigaChat-2-Max";

async function loadCredentials(): Promise<string> {
  if (process.env.GIGACHAT_CREDENTIALS) return process.env.GIGACHAT_CREDENTIALS;
  const fs = await import("node:fs");
  const cfgPath =
    process.env.GIGACHAT_OPENCODE_CONFIG ?? path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
    plugins?: Array<{ options?: { credentials?: string } }>;
    provider?: Record<string, { options?: { credentials?: string } }>;
  };
  const provider = Object.values(cfg.provider ?? {}).find((p) => p.options?.credentials);
  return provider?.options?.credentials ?? cfg.plugins?.[0]?.options?.credentials ?? "";
}

async function main() {
  const credentialsValue = await loadCredentials();
  if (!credentialsValue) throw new Error("no credentials");
  authManager.setCredentials(credentialsValue, "GIGACHAT_API_PERS", shouldVerifySsl(), DEFAULT_CA_BUNDLE_FILE);
  const { token } = await authManager.getAccessToken();
  const agent = getHttpsAgent(shouldVerifySsl(), DEFAULT_CA_BUNDLE_FILE);
  const http = axios.create({
    baseURL: BASE,
    httpsAgent: agent,
    timeout: 120_000,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
  });
  const post = async (body: unknown): Promise<{ status: number; data: unknown }> => {
    try {
      const res = await http.post("", body);
      return { status: res.status, data: res.data };
    } catch (err) {
      if (err instanceof AxiosError) return { status: err.response?.status ?? 0, data: err.response?.data };
      throw err;
    }
  };

  const openAiBody: OpenAiChatBody = {
    model: MODEL,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Какая погода в Москве? Вызови get_weather." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Погода в городе",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    tool_choice: "auto",
    stream: false,
  };

  /* ------------------------------ turn 1 ------------------------------ */
  const norm1 = openCodeToNormalized(openAiBody);
  const wire1 = normalizedToGigaChatV2(norm1);
  console.log("wire1 roles:", wire1.messages.map((m) => m.role).join(","));

  const r1 = await post(wire1);
  console.log("turn1 status:", r1.status);
  if (r1.status !== 200) {
    console.log("turn1 body:", JSON.stringify(wire1).slice(0, 1200));
    console.log("turn1 FAIL data:", r1.data === undefined ? "(empty)" : JSON.stringify(r1.data).slice(0, 240));
    return;
  }
  const normResp = gigachatV2ToNormalized(r1.data as ChatCompletionV2Response);
  const choice = normResp.choices[0];
  console.log(
    "normalized turn1: finish=", choice.finishReason,
    "| stateId=", choice.message.stateId ?? "(none)",
    "| toolCalls=", JSON.stringify(choice.message.toolCalls ?? null),
  );

  const firstCall = choice.message.toolCalls?.[0];
  if (!firstCall) {
    console.log("no tool call in turn1; abort");
    return;
  }

  /* ------------------------------ turn 2 ------------------------------ */
  const norm2: NormalizedRequest = {
    model: MODEL,
    messages: [
      { role: "user", content: [{ type: "text", text: "Какая погода в Москве? Вызови get_weather." }] },
      {
        role: "assistant",
        content: choice.message.content ? [{ type: "text", text: choice.message.content }] : [],
        toolCalls: choice.message.toolCalls,
        ...(choice.message.stateId !== undefined ? { stateId: choice.message.stateId } : {}),
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: firstCall.id, result: JSON.stringify({ city: "Moscow", temperature: 20 }) },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Спасибо. Ответь одним предложением по-русски." }] },
    ],
    tools: norm1.tools,
    toolChoice: "auto",
    stream: false,
  };
  const wire2 = normalizedToGigaChatV2(norm2);
  console.log(
    "wire2 roles:",
    wire2.messages.map((m) => m.role).join(","),
    "| assistant state:",
    wire2.messages.find((m) => m.role === "assistant")?.functions_state_id ?? "(none)",
  );

  const r2 = await post(wire2);
  if (r2.status >= 200 && r2.status < 300) {
    const done = gigachatV2ToNormalized(r2.data as ChatCompletionV2Response);
    console.log(
      "turn2 OK: finish=", done.choices[0].finishReason,
      "| text=", JSON.stringify(done.choices[0].message.content ?? "").slice(0, 160),
    );
  } else {
    console.log("turn2 FAIL:", r2.status, JSON.stringify(r2.data).slice(0, 240));
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});