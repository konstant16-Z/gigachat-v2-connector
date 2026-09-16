/**
 * PHASE 10 §23 — regression: reasoning controls keep the documented V2 behavior.
 *
 * Origin: src/v2/translator.ts §6 — V1 mapped `reasoning_effort` /
 * `thinking.budget_tokens` to Chain-of-Thought system prompts. MIGRATION.md
 * classifies those prompts as LEGACY to be removed after the V2 transition,
 * and the live API confirms no native reasoning field exists in V2
 * (normalized-to-gigachat-v2): reasoning is documented as not representable.
 * These tests pin that: no CoT prompt leaks into the wire, unsupported values
 * are controlled errors (agents.md RULE 13), and `stop` stays verbatim as a
 * documented not-representable drop.
 */
import { describe, expect, test } from "bun:test";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";

describe("§23 reasoning — legacy V1 CoT prompts stay out of the V2 wire", () => {
  test("reasoning_effort high/medium/low do not inject any system prompt", async () => {
    const pipeline = createV2Pipeline();
    for (const effort of ["high", "medium", "low"]) {
      const wire = await pipeline.chatRequest(
        {
          model: "GigaChat-2-Max",
          messages: [
            { role: "system", content: "You are a helper." },
            { role: "user", content: "q" },
          ],
          reasoning_effort: effort,
        },
        "s-reason-1",
      );
      // No CoT prompt appended; original system content untouched.
      expect(wire.messages[0].content).toEqual([{ text: "You are a helper." }]);
      expect(JSON.stringify(wire)).not.toContain("Chain-of-Thought");
      expect(JSON.stringify(wire)).not.toContain("CoT");
    }
  });

  test("thinking.budget_tokens passes normalization but stays off the wire", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "q" }],
        thinking: { budget_tokens: 4096 },
      },
      "s-reason-2",
    );
    expect(JSON.stringify(wire)).not.toContain("budget_tokens");
  });

  test("unsupported reasoning_effort → controlled error (V1 silently ignored it)", async () => {
    const pipeline = createV2Pipeline();
    await expect(
      pipeline.chatRequest(
        {
          model: "GigaChat-2-Max",
          messages: [{ role: "user", content: "q" }],
          reasoning_effort: "extreme",
        },
        "s-reason-3",
      ),
    ).rejects.toThrow(/unsupported reasoning_effort "extreme"/);
  });

  test("stop is a documented not-representable drop (V1 mapped it to gigaBody.stop)", async () => {
    const pipeline = createV2Pipeline();
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "q" }],
        stop: ["\n", "END"],
      },
      "s-reason-4",
    );
    // No stop-token list in V2 model_options (compatibility matrix).
    expect(wire.model_options?.temperature).toBeUndefined();
    expect(JSON.stringify(wire)).not.toContain("END");
  });
});
