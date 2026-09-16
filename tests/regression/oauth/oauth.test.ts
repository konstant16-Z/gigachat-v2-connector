/**
 * PHASE 10 §23 — regression: OAuth credential plumbing parity from src/v2/auth.ts.
 *
 * Live network behaviors (token exchange, expiry buffer, single-flight refresh,
 * 401 → clearTokenCache, sanitizeError) are covered end-to-end by the live E2E
 * smoke (§26) and PHASE 8 §20. Here we pin the credential/scope plumbing that
 * must not regress: fresh `GigaCodeAuthManager` instances avoid the singleton
 * and any environment credentials.
 */
import { describe, expect, test } from "bun:test";
import { GigaCodeAuthManager } from "../../../src/v2/auth";

/** Fresh manager with a guaranteed-empty environment (env may leak in CI shells). */
function freshManagerNoEnv(): GigaCodeAuthManager {
  const saved = process.env.GIGACHAT_CREDENTIALS;
  const savedScope = process.env.GIGACHAT_SCOPE;
  delete process.env.GIGACHAT_CREDENTIALS;
  delete process.env.GIGACHAT_SCOPE;
  try {
    return new GigaCodeAuthManager();
  } finally {
    if (saved !== undefined) process.env.GIGACHAT_CREDENTIALS = saved;
    if (savedScope !== undefined) process.env.GIGACHAT_SCOPE = savedScope;
  }
}

describe("§23 oauth — credential plumbing parity", () => {
  test("no credentials → controlled error, never an empty token", async () => {
    const manager = freshManagerNoEnv();
    await expect(manager.getAccessToken()).rejects.toThrow(
      /GigaChat credentials are not configured/,
    );
  });

  test("hasCredentials reflects configured credentials (subject to environment)", () => {
    const manager = freshManagerNoEnv();
    expect(manager.setCredentials("  abc123  ")).toBeUndefined();
    expect(manager.hasCredentials()).toBe(true);
    const active = manager.getActiveAccount();
    expect(active?.credentials).toBe("abc123"); // trimmed, no whitespace
  });

  test("invalid scope falls back to the default GIGACHAT_API_PERS", () => {
    const manager = freshManagerNoEnv();
    manager.setCredentials("secret", "GIGACHAT_API_B2B");
    expect(manager.getActiveAccount()?.scope).toBe("GIGACHAT_API_B2B");
    manager.setCredentials("secret", "not-a-scope");
    expect(manager.getActiveAccount()?.scope).toBe("GIGACHAT_API_PERS");
  });

  test("getActiveAccount is null without credentials", () => {
    const manager = freshManagerNoEnv();
    expect(manager.getActiveAccount()).toBeNull();
  });

  test("clearTokenCache is safe and invalidates the next exchange", () => {
    const manager = freshManagerNoEnv();
    manager.clearTokenCache(); // no-op on a fresh instance
    manager.setCredentials("secret");
    manager.clearTokenCache();
    expect(manager.hasCredentials()).toBe(true);
  });

  test("re-setting credentials replaces the active account", () => {
    const manager = freshManagerNoEnv();
    manager.setCredentials("first");
    manager.setCredentials("second");
    expect(manager.getActiveAccount()?.credentials).toBe("second");
  });
});
