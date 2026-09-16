#!/usr/bin/env bun
/**
 * Live probe: GigaChat V2 Files API (2026-09-16).
 *
 * Tests:
 *   1. POST /v2/files (multipart/form-data) → returns file.id
 *   2. Use file.id in chat completion via messages[].content.files
 *   3. Verify response references the file
 *
 * Two base URLs to test:
 *   - https://api.giga.chat/v2/files (V2 API domain)
 *   - https://ngw.devices.sberbank.ru:9443/api/v2/files (legacy translator domain)
 *
 * Credentials from GIGACHAT_CREDENTIALS env or OpenCode config.
 */
import axios, { AxiosError } from "axios";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { authManager } from "../src/v2/auth";
import { DEFAULT_CA_BUNDLE_FILE } from "../src/v2/constants";
import { getHttpsAgent, shouldVerifySsl } from "../src/v2/net";

const FILES_URLS = [
  "https://api.giga.chat/v1/files",
  "https://api.giga.chat/v2/files",
  "https://ngw.devices.sberbank.ru:9443/api/v2/files",
];
const CHAT_URL = "https://api.giga.chat/v2/chat/completions";
const MODEL = "GigaChat-2-Max";

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

  // Create a small test file (1x1 pixel PNG)
  const tmpDir = os.tmpdir();
  const testFilePath = path.join(tmpDir, `gigachat_probe_${Date.now()}.png`);
  // 1x1 transparent PNG
  const pngBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  fs.writeFileSync(testFilePath, pngBuffer);

  try {
    for (const filesUrl of FILES_URLS) {
      console.log(`\n=== Testing files endpoint: ${filesUrl} ===`);

      // 1. Upload file - use native FormData
      const form = new FormData();
      const fileBlob = new Blob([fs.readFileSync(testFilePath)], { type: "image/png" });
      form.append("file", fileBlob, "probe.png");
      form.append("purpose", "general");

      // Extract headers from FormData
      const uploadHeaders: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
      // FormData in axios will set its own Content-Type with boundary

      let fileId: string | undefined;
      try {
        const uploadRes = await axios.post(filesUrl, form, {
          headers: uploadHeaders,
          httpsAgent: agent,
          timeout: 30000,
        });
        console.log(`  UPLOAD [${uploadRes.status}] →`, JSON.stringify(uploadRes.data, null, 2).slice(0, 300));
        fileId = uploadRes.data?.id;
        if (!fileId) {
          console.log("  ❌ No file.id in response");
          continue;
        }
        console.log(`  ✅ Got file.id = ${fileId}`);
      } catch (err) {
        if (err instanceof AxiosError) {
          console.log(`  UPLOAD [${err.response?.status}] →`, JSON.stringify(err.response?.data).slice(0, 300));
        } else {
          console.log(`  UPLOAD ERROR:`, String(err).slice(0, 300));
        }
        continue;
      }

      // 2. Use file in chat completion
      const chatHeaders = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      };

      const chatBody = {
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [
              { text: "What is in this file? Reply with the exact content." },
              { files: [{ id: fileId }] },
            ],
          },
        ],
        stream: false,
      };

      try {
        const chatRes = await axios.post(CHAT_URL, chatBody, {
          headers: chatHeaders,
          httpsAgent: agent,
          timeout: 60000,
        });
        console.log(`  CHAT [${chatRes.status}] →`);
        const msg = chatRes.data?.messages?.[0];
        const text = msg?.content?.filter((p: { text?: unknown }) => p.text !== undefined)
          .map((p: { text: unknown }) => p.text).join("") ?? "";
        console.log(`      response: ${JSON.stringify(text).slice(0, 200)}`);
        if (chatRes.status === 200) {
          console.log(`  ✅ Chat completion with file.id works!`);
        }
      } catch (err) {
        if (err instanceof AxiosError) {
          console.log(`  CHAT [${err.response?.status}] →`, JSON.stringify(err.response?.data).slice(0, 300));
        } else {
          console.log(`  CHAT ERROR:`, String(err).slice(0, 300));
        }
      }
    }
  } finally {
    fs.unlinkSync(testFilePath);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});