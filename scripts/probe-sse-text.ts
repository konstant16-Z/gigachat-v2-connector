#!/usr/bin/env bun
import axios from "axios";
import { authManager } from "../src/v2/auth";
import { getHttpsAgent, shouldVerifySsl } from "../src/v2/net";
import { DEFAULT_CA_BUNDLE_FILE } from "../src/v2/constants";

const BASE = "https://api.giga.chat/v2/chat/completions";
async function main() {
  let credentialsValue: string | undefined = process.env.GIGACHAT_CREDENTIALS;
  if (!credentialsValue) {
    const fs = await import("node:fs");
    const cfg = JSON.parse(fs.readFileSync("/home/zkons/.config/opencode/opencode.json", "utf8")) as {
      plugins?: Array<{ options?: { credentials?: string } }>;
      provider?: Record<string, { options?: { credentials?: string } }>;
    };
    const provider = Object.values(cfg.provider ?? {}).find((p) => p.options?.credentials);
    credentialsValue = provider?.options?.credentials ?? cfg.plugins?.[0]?.options?.credentials;
  }
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
  const res = await http.post("", {
    model: "GigaChat-2-Max",
    messages: [{ role: "user", content: [{ text: "Проверка SSE-дельты. Напиши дословно: один, два, три." }] }],
    stream: true,
  }, { responseType: "text" });
  const sse = String(res.data);
  console.log("SSE RAW (first 2500 chars):");
  console.log("---------------------------");
  console.log(sse.slice(0, 2500));
  console.log("---------------------------");
}
main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});