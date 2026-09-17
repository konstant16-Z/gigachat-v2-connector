/**
 * Constants and logging helpers.
 * Mirrors the top of the original bundle (src/v2/index.ts).
 */
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets } from "../core/redact.js";

/** GigaChat OAuth2 token endpoint */
export const GIGACHAT_OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
/** GigaChat Chat Completions endpoint */
export const GIGACHAT_COMPLETIONS_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions";
/** GigaChat V2 Chat Completions endpoint (V2 target, plan §22) */
export const GIGACHAT_V2_COMPLETIONS_URL = "https://api.giga.chat/v2/chat/completions";
/** GigaChat Files (attachments) endpoint — live-verified 2026-09-16: /v1/files works, /v2/files returns 403 */
export const GIGACHAT_FILES_URL = "https://api.giga.chat/v1/files";

/** OpenCode shared config directory */
export const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");
/** Default path to the Russian Trusted Root CA PEM file */
export const DEFAULT_CA_BUNDLE_FILE = path.join(CONFIG_DIR, "certs", "russian_trusted_root_ca.pem");

/** Refresh the OAuth token this many seconds before it actually expires */
export const REFRESH_BUFFER_SECONDS = 300;

export function debugEnabled(): boolean {
  return process.env.GIGACHAT_DEBUG === "true" || process.env.OPENCODE_DEBUG === "true";
}

export function log(message: string, metadata?: unknown): void {
  if (!debugEnabled()) return;
  const meta = metadata !== undefined ? ` ${redactSecrets(JSON.stringify(metadata))}` : "";
  console.log(`[GigaCode] [INFO] ${redactSecrets(message)}${meta}`);
}

export function warn(message: string, metadata?: unknown): void {
  const meta = metadata !== undefined ? ` ${redactSecrets(JSON.stringify(metadata))}` : "";
  console.warn(`[GigaCode] [WARN] ${redactSecrets(message)}${meta}`);
}

export function error(message: string, metadata?: unknown): void {
  const meta = metadata !== undefined ? ` ${redactSecrets(JSON.stringify(metadata))}` : "";
  console.error(`[GigaCode] [ERROR] ${redactSecrets(message)}${meta}`);
}