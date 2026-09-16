#!/usr/bin/env bun
/**
 * Diagnostic probe for the PHASE 10 smoke failure ("invalid JSON syntax").
 * Determines whether the plugin's own outbound request is valid, and what
 * each endpoint says about unmodified OpenAI-format bodies.
 *
 * Tests:
 *   1. v2 + pipeline-mapped body + real token  (what the plugin SHOULD send)
 *   2. v2 + unmodified OpenAI body + real token (hypothesis: hook not honored)
 *   3. v1 + unmodified OpenAI body + Bearer <creds> (hypothesis: hook skipped)
 *
 * Credentials: read from env/config as in probe-response-format.ts. Never printed.
 */
import axios, { AxiosError } from "axios";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { authManager } from "../../src/v2/auth";
import { DEFAULT_CA_BUNDLE_FILE, GIGACHAT_V2_COMPLETIONS_URL } from "../../src/v2/constants";
import { getHttpsAgent, shouldVerifySsl } from "../../src/v2/net";

async function loadCredentials(): Promise<string> {
  if (process.env.GIGACHAT_CREDENTIALS) return process.env.GIGACHAT_CREDENTIALS;
  const cfgPath =
    process.env.GIGACHAT_OPENCODE_CONFIG ??
    path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
    plugins?: Array<{ options?: { credentials?: string } }>;
    provider?: Record<string, { options?: { credentials?: string } }>;
  };
  const provider = Object.values(cfg.provider ?? {}).find((p) => p.options?.credentials);
  return provider?.options?.credentials ?? cfg.plugins?.[0]?.options?.credentials ?? "";
}

const OPENAI_BODY = {
  model: "GigaChat-2-Max",
  messages: [{ role: "user", content: "Say OK" }],
  stream: true,
};

async function post(label: string, url: string, body: unknown, token: string, agent: ReturnType<typeof getHttpsAgent>) {
  try {
    const res = await axios.post(url, body, {
      httpsAgent: agent,
      timeout: 120_000,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        RqUID: "smoke-probe-1",
      },
    });
    const msg = res.data?.messages?.[0] as { content?: Array<{ text?: string }> } | undefined;
    const text = msg?.content?.map((p) => p.text ?? "").join("") ?? "";
    console.log(`[${String(res.status)}] ${label} -> text=${JSON.stringify(text).slice(0, 100)}`);
  } catch (err) {
    if (err instanceof AxiosError) {
      const data = err.response?.data as { status?: unknown; message?: unknown } | undefined;
      console.log(
        `[${String(err.response?.status ?? 0)}] ${label} -> ${JSON.stringify({ status: data?.status, message: String(data?.message ?? "").slice(0, 220) })}`,
      );
    } else {
      console.log(`[ERR] ${label} -> ${String(err)}`);
    }
  }
}

async function main() {
  const credentialsValue = await loadCredentials();
  if (!credentialsValue) throw new Error("no credentials");
  authManager.setCredentials(credentialsValue, "GIGACHAT_API_PERS", shouldVerifySsl(), DEFAULT_CA_BUNDLE_FILE);
  const { token } = await authManager.getAccessToken();
  const agent = getHttpsAgent(shouldVerifySsl(), DEFAULT_CA_BUNDLE_FILE);

  const { createV2Pipeline } = await import("../../src/translation/v2-pipeline");
  const pipeline = createV2Pipeline({ onSseError: (m) => console.error("SSE:", m) });
  const mapped = (await pipeline.chatRequest(
    JSON.parse(JSON.stringify(OPENAI_BODY)),
    "smoke-probe-session",
  )) as unknown;
  console.log("mapped body keys:", Object.keys(mapped as Record<string, unknown>).join(", "));

  console.log("\n-- test 1: v2 + pipeline-mapped body + real token (plugin equivalent) --");
  await post("v2 mapped", GIGACHAT_V2_COMPLETIONS_URL, mapped, token, agent);

  console.log("\n-- test 2: v2 + unmodified OpenAI body + real token (hook not honored?) --");
  await post("v2 raw", GIGACHAT_V2_COMPLETIONS_URL, OPENAI_BODY, token, agent);

  console.log("\n-- test 3: v1 + unmodified OpenAI body + Bearer creds (hook skipped?) --");
  await post("v1 raw", "https://api.giga.chat/v1/chat/completions", OPENAI_BODY, credentialsValue, agent);

  console.log("\n-- test 4: v1 + unmodified OpenAI body + real token --");
  await post("v1 raw token", "https://api.giga.chat/v1/chat/completions", OPENAI_BODY, token, agent);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});