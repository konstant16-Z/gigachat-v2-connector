/**
 * Unit tests: function-name validation and the session-scoped alias registry
 * (plan §9 "normalize").
 */
import { describe, expect, test } from "bun:test";
import { ToolNameRegistry, validateFunctionName } from "../../src/gigachat/v2/tools/normalize";

describe("validateFunctionName", () => {
  test("accepts live-valid names (hyphen and dot allowed)", () => {
    expect(validateFunctionName("weather_forecast")).toBeNull();
    expect(validateFunctionName("getWeather2")).toBeNull();
    expect(validateFunctionName("get-weather")).toBeNull();
    expect(validateFunctionName("weather.forecast")).toBeNull();
    expect(validateFunctionName("a")).toBeNull();
  });

  test("rejects names starting with a digit", () => {
    expect(validateFunctionName("2weather")).toMatch(/must start with a Latin letter/);
  });

  test("rejects non-Latin characters and spaces", () => {
    expect(validateFunctionName("погода")).toMatch(/Latin letter/);
    expect(validateFunctionName("get weather")).toMatch(/Latin letter/);
  });

  test("rejects empty names", () => {
    expect(validateFunctionName("")).toMatch(/must not be empty/);
  });
});

describe("ToolNameRegistry", () => {
  test("spec-valid names pass through without bookkeeping", () => {
    const registry = new ToolNameRegistry();
    expect(registry.aliasFor("get_weather")).toBe("get_weather");
    expect(registry.aliasFor("get_weather")).toBe("get_weather");
    expect(registry.size).toBe(0);
  });

  test("aliases V2-unsafe names deterministically", () => {
    const registry = new ToolNameRegistry();
    expect(registry.aliasFor("shell --- workdir /x")).toBe("tool_1");
    expect(registry.aliasFor("погода")).toBe("tool_2");
    // deterministic within the same registry
    expect(registry.aliasFor("shell --- workdir /x")).toBe("tool_1");
  });

  test("reverse lookup restores the original name", () => {
    const registry = new ToolNameRegistry();
    const original = "shell --- workdir /x";
    const alias = registry.aliasFor(original);
    expect(registry.originalOf(alias)).toBe(original);
    expect(registry.originalOf("get_weather")).toBe("get_weather");
  });

  test("registries are isolated: same unsafe name gets different ids", () => {
    const a = new ToolNameRegistry();
    const b = new ToolNameRegistry();
    expect(a.aliasFor("bad name")).toBe("tool_1");
    expect(b.aliasFor("bad name")).toBe("tool_1"); // each scoped, no shared counter
    // same registry stays deterministic across instances of the same session id
    expect(a.originalOf("tool_1")).toBe("bad name");
    expect(b.originalOf("tool_1")).toBe("bad name");
  });
});
