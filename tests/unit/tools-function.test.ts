/**
 * Unit tests: CustomFunction shaping (plan §9 "function").
 */
import { describe, expect, test } from "bun:test";
import { toCustomFunction } from "../../src/gigachat/v2/tools/function";

describe("toCustomFunction", () => {
  test("shapes a full function tool", () => {
    const fn = toCustomFunction({
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    });
    expect(fn).toEqual({
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    });
  });

  test("passes provider-specific extras through", () => {
    const fn = toCustomFunction({
      name: "f",
      parameters: { type: "object" },
      fewShotExamples: [{ request: "x", params: { a: 1 } }],
      returnParameters: { type: "string" },
    });
    expect(fn.few_shot_examples).toEqual([{ request: "x", params: { a: 1 } }]);
    expect(fn.return_parameters).toEqual({ type: "string" });
  });

  test("spec requires name — controlled error, no guess", () => {
    expect(() => toCustomFunction({ name: "", parameters: { type: "object" } })).toThrow(
      /requires a non-empty `name`/,
    );
  });

  test("spec requires parameters object — controlled error", () => {
    expect(() => toCustomFunction({ name: "f" })).toThrow(/requires `parameters`/);
    expect(() => toCustomFunction({ name: "f", parameters: "nope" })).toThrow(
      /requires `parameters`/,
    );
    expect(() => toCustomFunction({ name: "f", parameters: ["a"] })).toThrow(
      /requires `parameters`/,
    );
  });
});
