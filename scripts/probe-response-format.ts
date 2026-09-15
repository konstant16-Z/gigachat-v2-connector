#!/usr/bin/env bun
/**
 * Live probe: which `model_options.response_format` variants does the V2 API
 * actually accept? (2026-09-16)
 *
 * Spec (docs/external/gigachat-api.yml): ChatResponseFormat discriminates on
 * `type` with only `text` | `json_schema`; `json_schema` REQUIRES `schema`.
 * The current mapper (normalized-to-gigachat-v2.ts) emits json_object → {type:"json"}
 * and can emit json_schema without schema — both need live confirmation.
 *
 * Tested variants (each one request, model GigaChat-2-Max):
 *   1. {type:"text"}
 *   2. {type:"json"}              (current json_object mapping)
 *   3. {type:"json_object"}       (raw OpenAI-style inside model_options)
 *   4. {type:"json_schema", schema:{...}}            (spec-valid)
 *   5. {type:"json_schema"}                          (schema omitted — mapper can emit)
 *   6. {type:"json_schema", schema:{...}, strict:true} (spec-valid strict)
 *   7. {type:"xml"}               (invalid type → expect 4xx)
 *
 * Credentials are read from GIGACHAT_CREDENTIALS env or the local OpenCode
 * config; never printed. Run from the repo root:
 *   bun run scripts/probe-response-format.ts
 */
import axios, { AxiosError } from "axios";
import * as os from "node:os";
import * as path from "node:path";
import { authManager } from "../src/v2/auth";
import { DEFAULT_CA_BUNDLE_FILE } from "../src/v2/constants";
import { getHttpsAgent, shouldVerifySsl } from "../src/v2/net";

const BASE = "https://api.giga.chat/v2/chat/completions";
const MODEL = "GigaChat-2-Max";

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

const VARIANTS: Array<{ label: string; build: () => unknown }> = [
  { label: "NO model_options (baseline)", build: () => ({}) },
  { label: "temperature only", build: () => ({ model_options: { temperature: 0.7 } }) },
  { label: "text", build: () => ({ model_options: { response_format: { type: "text" } } }) },
  { label: "json", build: () => ({ model_options: { response_format: { type: "json" } } }) },
  { label: "json_object", build: () => ({ model_options: { response_format: { type: "json_object" } } }) },
  {
    label: "json_schema+schema",
    build: () => ({ model_options: { response_format: { type: "json_schema", schema: SCHEMA } } }),
  },
  { label: "json_schema w/o schema", build: () => ({ model_options: { response_format: { type: "json_schema" } } }) },
  {
    label: "json_schema+strict",
    build: () => ({ model_options: { response_format: { type: "json_schema", schema: SCHEMA, strict: true } } }),
  },
  { label: "invalid type", build: () => ({ model_options: { response_format: { type: "xml" } } }) },
];

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

  console.log(`response_format probe | model=${MODEL}`);
  for (const v of VARIANTS) {
    const extra = v.build();
    const body = {
      model: MODEL,
      messages: [{ role: "user", content: [{ text: "Верни ровно одно слово: свет. Ничего больше." }] }],
      ...extra,
    };
    try {
      const res = await http.post("", body);
      if (res.status === 200) {
        const msg = res.data?.messages?.[0];
        const text = msg?.content?.filter((p: { text?: unknown }) => p.text !== undefined)
          .map((p: { text: unknown }) => p.text).join("") ?? "";
        console.log(
          `[${String(res.status)}] ${v.label.padEnd(24)} → text=${JSON.stringify(text).slice(0, 80)}`,
        );
        console.log(`      raw response_format... content.length=${text.length}`);
        if (v.label.includes("json") && text.length > 0) {
          console.log(`      isJSON=${(() => { try { JSON.parse(text); return "yes"; } catch { return "no"; } })()}`);
        }
      } else {
        const data = res.data as { status?: unknown; message?: unknown };
        console.log(
          `[${String(res.status)}] ${v.label.padEnd(24)} → ${JSON.stringify({ status: data.status, message: String(data.message ?? "").slice(0, 200) })}`,
        );
      }
    } catch (err) {
      if (err instanceof AxiosError) {
        const data = err.response?.data as { status?: unknown; message?: unknown } | undefined;
        console.log(
          `[${String(err.response?.status ?? 0)}] ${v.label.padEnd(24)} → ${JSON.stringify({ status: data?.status, message: String(data?.message ?? "").slice(0, 200) })}`,
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