#!/usr/bin/env bun
/**
 * Live probe: builtin-tool streaming shape + code_interpreter availability.
 * (2026-09-16, supplemental to scripts/probe-builtin-tools.ts)
 *
 * Two cases:
 *   1. `web_search` with `stream: true` — captures the SSE event/data lines:
 *      does a server-side builtin call emit function_call/function_in_progress
 *      events, or plain text deltas? (Live answer: plain text deltas only.)
 *   2. `code_interpreter` (P2 desired) — accepted or rejected? (Live: 422
 *      "Tool code_interpreter is unavailable".)
 *
 * Credentials from env or local OpenCode config; never printed. Run:
 *   bun run scripts/probe-builtin-streaming.ts
 */
import axios, { AxiosError } from "axios";
import * as os from "node:os";
import * as path from "node:path";
import { authManager } from "../src/v2/auth";
import { DEFAULT_CA_BUNDLE_FILE } from "../src/v2/constants";
import { getHttpsAgent, shouldVerifySsl } from "../src/v2/net";

const BASE = "https://api.giga.chat/v2/chat/completions";
const MODEL = "GigaChat-2-Max";

async function loadCredentials(): Promise<string> {
  if (process.env.GIGACHAT_CREDENTIALS) return process.env.GIGACHAT_CREDENTIALS;
  const fs = await import("node:fs");
  const cfgPath =
    process.env.GIGACHAT_OPENCODE_CONFIG ??
    path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
    provider?: Record<string, { options?: { credentials?: string } }>;
  };
  const provider = Object.values(cfg.provider ?? {}).find((p) => p.options?.credentials);
  return provider?.options?.credentials ?? "";
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

  const cases: Array<[string, unknown, boolean]> = [
    ["code_interpreter (auto)", { tools: [{ code_interpreter: {} }], tool_config: { mode: "auto" } }, false],
    ["web_search streaming", { tools: [{ web_search: {} }], tool_config: { mode: "auto" }, stream: true }, true],
  ];
  const prompts: Record<string, string> = {
    "code_interpreter (auto)": "Вычисли 2+2 и скажи, какая сегодня дата.",
    "web_search streaming": "Найди в интернете: кто сейчас президент Франции?",
  };

  for (const [label, extra, isStream] of cases) {
    const body = {
      model: MODEL,
      messages: [{ role: "user", content: [{ text: prompts[label] }] }],
      ...extra,
    };
    try {
      const res = await http.post("", body, { responseType: isStream ? "stream" : "json", timeout: 120000 });
      if (isStream) {
        let buf = "";
        for await (const chunk of res.data) buf += chunk.toString();
        const seen = new Set<string>();
        for (const line of buf.split("\n")) {
          if (!line.startsWith("data:") || line === "data: [DONE]") continue;
          try {
            const j = JSON.parse(line.slice(5));
            const msgs = j.messages?.length ? j.messages : [];
            const parts: string[] = [`event=${String(j.event ?? "?")}`];
            for (const m of msgs) {
              parts.push(`role=${String(m.role ?? "?")}`);
              const content = Array.isArray(m.content)
                ? m.content
                    .filter((p: { text?: string }) => p.text)
                    .map((p: { text: string }) => p.text)
                    .join("")
                : "";
              if (content) parts.push(`text=${JSON.stringify(content).slice(0, 120)}`);
              if (m.function_call?.name) parts.push(`fcall=${m.function_call.name}`);
              if (m.additional_data?.sources) {
                parts.push(`sources=${JSON.stringify(m.additional_data.sources).slice(0, 150)}`);
              }
            }
            const key = parts.join(" ");
            if (!seen.has(key)) {
              seen.add(key);
              console.log(`  ${key}`);
            }
          } catch {
            // skip unparseable data lines
          }
        }
        if (!seen.size) console.log(`  [no parseable data lines] raw=${JSON.stringify(buf).slice(0, 200)}`);
      } else {
        const d = res.data as { messages?: Array<Record<string, unknown>> };
        const m = d.messages?.[0];
        const content = Array.isArray(m?.content)
          ? m.content
              .filter((p: { text?: string }) => p.text)
              .map((p: { text: string }) => p.text)
              .join("")
          : "";
        console.log(`[${res.status}] ${label} → role=${String(m?.role)} text=${JSON.stringify(content).slice(0, 180)}`);
      }
    } catch (err) {
      if (err instanceof AxiosError) {
        const data = err.response?.data as { status?: unknown; message?: unknown } | undefined;
        console.log(
          `[${String(err.response?.status ?? 0)}] ${label} → ${JSON.stringify({ status: data?.status, message: String(data?.message ?? "").slice(0, 200) })}`,
        );
      } else {
        console.log(`[ERR] ${label} → ${String(err)}`);
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});