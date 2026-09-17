/**
 * PHASE 11 §24 — V2 compatibility suite: structured-output zone.
 *
 * Contract table:
 *
 *   OpenAI response_format ──chatRequest──▶ `model_options.response_format`
 *
 * Live API facts (docs/LIVE_API_OBSERVATIONS.md 2026-09-16):
 * - V2 accepts only `text` | `json_schema`; `json`/`json_object` → 400 →
 *   controlled error here (REFUSE to guess);
 * - `json_schema` without a schema → 400 "Empty schema ..." → controlled error;
 * - reasoning controls have no V2 model_options field (model choice controls
 *   reasoning) — documented degraded mapping, nothing is sent.
 */
import { describe, expect, test } from "bun:test";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";
import { jsonSchemaRequest } from "../../fixtures/requests/openai";

const noop = (): void => {};

describe("§24 structured-output zone — response_format wire contract", () => {
  test("json_schema → model_options.response_format with schema + strict", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const wire = await pipeline.chatRequest(jsonSchemaRequest, "struct-sess");

    expect(wire.model_options?.response_format).toEqual({
      type: "json_schema",
      schema: { type: "object", properties: { date: { type: "string" } } },
      strict: true,
    });
    // reasoning_effort "high" is not representable in V2 model_options —
    // nothing is emitted, the request is not silently altered.
    expect(wire.model_options).not.toHaveProperty("reasoning");
  });

  test("json_object → controlled error (live API rejects json/json_object)", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    await expect(
      pipeline.chatRequest(
        {
          model: "GigaChat-2-Max",
          messages: [{ role: "user", content: "hi" }],
          response_format: { type: "json_object" },
        },
        "struct-sess",
      ),
    ).rejects.toThrow(/response_format "json_object" is not representable in V2/);
  });

  test("json_schema without a schema → controlled error", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    await expect(
      pipeline.chatRequest(
        {
          model: "GigaChat-2-Max",
          messages: [{ role: "user", content: "hi" }],
          response_format: { type: "json_schema" },
        },
        "struct-sess",
      ),
    ).rejects.toThrow(/response_format "json_schema" requires a schema/);
  });

  test("explicit text format is emitted (RULE 13: no silent changes)", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const wire = await pipeline.chatRequest(
      {
        model: "GigaChat-2-Max",
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "text" },
      },
      "struct-sess",
    );
    expect(wire.model_options?.response_format).toEqual({ type: "text" });
  });
});
