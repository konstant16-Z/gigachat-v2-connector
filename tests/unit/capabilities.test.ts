/**
 * Unit tests: model capability map (plan §17).
 *
 * Capability filtering happens at the boundaries (builtin registry, image URL
 * and response_format controlled errors); this map codifies the live-verified
 * capability set per model and the unknown-model fallback.
 */
import { describe, expect, test } from "bun:test";
import { getModelCapabilities } from "../../src/gigachat/v2/capabilities";

describe("getModelCapabilities", () => {
  test("known models expose the full live-verified capability set", () => {
    for (const model of ["GigaChat-2-Max", "GigaChat-2-Pro", "GigaChat-3-Ultra"]) {
      const caps = getModelCapabilities(model);
      expect(caps.tools).toBe(true);
      expect(caps.webSearch).toBe(true);
      expect(caps.files).toBe(true);
      expect(caps.structuredOutput).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.reasoning).toBe(true);
    }
  });

  test("unknown model ids fall back to the verified set (not empty)", () => {
    const caps = getModelCapabilities("totally-unknown-model");
    expect(caps.tools).toBe(true);
    expect(caps.files).toBe(true);
  });

  test("returned map is a copy (callers cannot mutate the shared truth)", () => {
    const a = getModelCapabilities("GigaChat-2-Max");
    a.tools = false;
    expect(getModelCapabilities("GigaChat-2-Max").tools).toBe(true);
  });
});
