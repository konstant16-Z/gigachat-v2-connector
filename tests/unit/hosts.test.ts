/**
 * Unit tests: host detection and URL rewriting helpers.
 *
 * Covers the GigaChat V2 smoke-failure fix (PHASE 10): api.giga.chat must
 * resolve to the V2 completions endpoint when v2 mode is active.
 */
import { describe, expect, test } from "bun:test";
import {
  GIGACHAT_COMPLETIONS_URL,
  GIGACHAT_FILES_URL,
  GIGACHAT_V2_COMPLETIONS_URL,
} from "../../src/v2/constants";
import {
  gigaHosts,
  isGigaProvider,
  targetUrlFor,
  targetV2UrlFor,
  tryHost,
} from "../../src/v2/hosts";

describe("gigaHosts", () => {
  test("contains the real production host and the dev alias", () => {
    expect(gigaHosts.has("api.giga.chat")).toBe(true);
    expect(gigaHosts.has("api.gigachat.local")).toBe(true);
    expect(gigaHosts.has("ngw.devices.sberbank.ru")).toBe(true);
    expect(gigaHosts.has("gigachat.devices.sberbank.ru")).toBe(true);
  });
});

describe("isGigaProvider", () => {
  test("recognises short IDs and substrings", () => {
    expect(isGigaProvider("gigachat")).toBe(true);
    expect(isGigaProvider("GigaChat 3 (api.giga.chat)")).toBe(true);
    expect(isGigaProvider("gigacode")).toBe(true);
    expect(isGigaProvider("my-app")).toBe(false);
    expect(isGigaProvider(undefined)).toBe(false);
  });
});

describe("tryHost", () => {
  test("extracts host from full URLs and returns undefined on parse error", () => {
    expect(tryHost("https://api.giga.chat/v1/chat/completions")).toBe("api.giga.chat");
    expect(tryHost("http://127.0.0.1:9181/v1")).toBe("127.0.0.1:9181");
    expect(tryHost("not-a-url")).toBeUndefined();
  });
});

describe("targetV2UrlFor", () => {
  test("maps known giga hosts to the V2 completions endpoint", () => {
    expect(targetV2UrlFor("http://api.gigachat.local/v1/chat/completions")).toBe(
      GIGACHAT_V2_COMPLETIONS_URL,
    );
    expect(targetV2UrlFor("https://api.giga.chat/v1/chat/completions")).toBe(
      GIGACHAT_V2_COMPLETIONS_URL,
    );
    expect(targetV2UrlFor("http://gigachat.devices.sberbank.ru/api/v1/chat/completions")).toBe(
      GIGACHAT_V2_COMPLETIONS_URL,
    );
  });

  test("passes through unknown hosts unchanged", () => {
    const url = "http://127.0.0.1:9181/v1/chat/completions";
    expect(targetV2UrlFor(url)).toBe(url);
  });
});

describe("targetUrlFor (V1 fallback path)", () => {
  test("maps api.gigachat.local chat to the legacy completions URL", () => {
    expect(targetUrlFor("http://api.gigachat.local/v1/chat/completions", true, false)).toBe(
      GIGACHAT_COMPLETIONS_URL,
    );
  });

  test("maps api.gigachat.local files to the files URL", () => {
    expect(targetUrlFor("http://api.gigachat.local/v1/files", false, true)).toBe(
      GIGACHAT_FILES_URL,
    );
  });

  test("passes through unknown hosts unchanged", () => {
    const url = "http://127.0.0.1:9181/v1/chat/completions";
    expect(targetUrlFor(url, true, false)).toBe(url);
  });
});
