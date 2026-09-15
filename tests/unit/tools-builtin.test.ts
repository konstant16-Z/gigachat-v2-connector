/**
 * Unit tests: builtin tool wire entries (plan §9 "builtin").
 */
import { describe, expect, test } from "bun:test";
import { isKnownBuiltinTool, toV2BuiltinTool } from "../../src/gigachat/v2/tools/builtin";

describe("builtin tools", () => {
  test("known builtins map to keyed V2 entries", () => {
    expect(toV2BuiltinTool("image_generate")).toEqual({ image_generate: {} });
    expect(toV2BuiltinTool("model_3d_generate")).toEqual({ model_3d_generate: {} });
    expect(isKnownBuiltinTool("image_generate")).toBe(true);
  });

  test("unknown builtin id raises a controlled error", () => {
    expect(isKnownBuiltinTool("web_search")).toBe(false);
    expect(() => toV2BuiltinTool("web_search")).toThrow(/unknown builtin tool "web_search"/);
  });
});
