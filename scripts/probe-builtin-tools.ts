#!/usr/bin/env bun
/**
 * Live probe: which builtin tools does the V2 API actually expose? (2026-09-16)
 *
 * The spec (`docs/external/gigachat-api.yml`) declares exactly two builtin
 * tools — `image_generate` and `model_3d_generate` (plan §9 "builtin"). The
 * plan §16 lists P1 `web_search` / `url_content_extraction` as desired *if the
 * API exposes them*. This probe determines availability + the error shape for
 * unknown tools (which may enumerate the supported set).
 *
 * Wire shape (spec, example at line 1463):
 *   tools:        [{ "<builtin_id>": {} }]
 *   tool_config:  { mode: "auto" }   (forced requires tool_name)
 *
 * Variants (each one request, model GigaChat-2-Max):
 *   1. web_search in tools (auto)            — P1 desired
 *   2. url_content_extraction in tools (auto) — P1 desired
 *   3. url_extraction in tools (auto)         — alternate name (COMPATIBILITY row)
 *   4. zzz_not_a_real_tool in tools (auto)    — unknown tool → error shape
 *   5. forced web_search (mode forced + tool_name) — forced-mode error shape
 *   6. code_interpreter in tools (auto)       — P2 desired (live: 422 unavailable)
 *   7. no tools (baseline)                   — control
 *
 * Notes:
 *   - `image_generate` / `model_3d_generate` (spec-declared) are NOT probed to
 *     avoid burning image/3D generation quota; spec already declares them.
 *   - Credentials read from GIGACHAT_CREDENTIALS env or local OpenCode config;
 *     never printed. Run from the repo root:
 *       bun run scripts/probe-builtin-tools.ts
 */
import axios, { AxiosError } from "axios";
import * as os from "node:os";
import * as path from "node:path";
import { authManager } from "../src/v2/auth";
import { DEFAULT_CA_BUNDLE_FILE } from "../src/v2/constants";
import { getHttpsAgent, shouldVerifySsl } from "../src/v2/net";

const BASE = "https://api.giga.chat/v2/chat/completions";
const MODEL = "GigaChat-2-Max";

const VARIANTS: Array<{
  label: string;
  build: () => unknown;
}> = [
  {
    label: "web_search (auto)",
    build: () => ({
      tools: [{ web_search: {} }],
      tool_config: { mode: "auto" },
    }),
  },
  {
    label: "url_content_extraction (auto)",
    build: () => ({
      tools: [{ url_content_extraction: {} }],
      tool_config: { mode: "auto" },
    }),
  },
  {
    label: "url_extraction (auto)",
    build: () => ({
      tools: [{ url_extraction: {} }],
      tool_config: { mode: "auto" },
    }),
  },
  {
    label: "unknown tool (auto)",
    build: () => ({
      tools: [{ zzz_not_a_real_tool: {} }],
      tool_config: { mode: "auto" },
    }),
  },
  {
    label: "forced web_search",
    build: () => ({
      tools: [{ web_search: {} }],
      tool_config: { mode: "forced", tool_name: "web_search" },
    }),
  },
  {
    label: "code_interpreter (auto)",
    build: () => ({
      tools: [{ code_interpreter: {} }],
      tool_config: { mode: "auto" },
    }),
  },
  {
    label: "no tools (baseline)",
    build: () => ({}),
  },
];

const PROMPTS: Record<string, string> = {
  "web_search (auto)":
    "Найди в интернете и кратко скажи: какая сейчас погода в Москве?",
  "url_content_extraction (auto)": "Извлеки и кратко перескажи содержимое страницы https://example.com",
  "url_extraction (auto)": "Извлеки и кратко перескажи содержимое страницы https://example.com",
  "unknown tool (auto)": "Привет",
  "forced web_search": "Привет",
  "code_interpreter (auto)": "Вычисли 2+2 и скажи, какая сегодня дата.",
  "no tools (baseline)": "Привет",
};

async function loadCredentials(): Promise<string> {
  if (process.env.GIGACHAT_CREDENTIALS) return process.env.GIGACHAT_CREDENTIALS;
  const fs = await import("node:fs");
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

function summarize(data: unknown): string {
  if (!data || typeof data !== "object") return JSON.stringify(data).slice(0, 200);
  const d = data as Record<string, unknown>;
  // Error envelope: { status, message }
  if (typeof d.message === "string") {
    return JSON.stringify({ status: d.status, message: d.message.slice(0, 300) });
  }
  // Chat messages: role/user text, function_call names, sources
  const messages = d.messages as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(messages) && messages.length > 0) {
    const lines: string[] = [];
    for (const m of messages) {
      const role = String(m.role ?? "");
      const content = m.content as Array<Record<string, unknown>> | undefined;
      const texts = Array.isArray(content)
        ? content
            .filter((p) => typeof p.text === "string")
            .map((p) => p.text as string)
            .join("")
        : String(m.text ?? "");
      const fcall = m.function_call as Record<string, unknown> | undefined;
      if (fcall?.name) lines.push(`function_call.name=${String(fcall.name)}`);
      if (texts) lines.push(`text=${JSON.stringify(texts).slice(0, 160)}`);
      const extra = m.additional_data as Record<string, unknown> | undefined;
      if (extra?.sources) lines.push(`sources=${JSON.stringify(extra.sources).slice(0, 200)}`);
      if (role === "function_in_progress") lines.push("!! function_in_progress");
    }
    return lines.join(" | ") || JSON.stringify(d).slice(0, 200);
  }
  return JSON.stringify(d).slice(0, 200);
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

  console.log(`builtin-tools probe | model=${MODEL}`);
  for (const v of VARIANTS) {
    const body = {
      model: MODEL,
      messages: [{ role: "user", content: [{ text: PROMPTS[v.label] }] }],
      ...v.build(),
    };
    try {
      const res = await http.post("", body);
      const summarized = summarize(res.data);
      console.log(`[${String(res.status)}] ${v.label.padEnd(28)} → ${summarized}`);
    } catch (err) {
      if (err instanceof AxiosError) {
        console.log(
          `[${String(err.response?.status ?? 0)}] ${v.label.padEnd(28)} → ${summarize(err.response?.data)}`,
        );
      } else {
        console.log(`[ERR] ${v.label} → ${String(err)}`);
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});