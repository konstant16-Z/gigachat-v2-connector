/**
 * PHASE 11 §24 — V2 compatibility suite: multimodal zone.
 *
 * Contract table:
 *
 *   image input ──▶ controlled error or wire `content.files`
 *   fake files response ──▶ OpenCode completion / normalized surface
 *
 * Pinned facts:
 * - V2 has no image content part; images travel as uploaded files
 *   (`content.files`). HTTP(S) URLs are unsupported → controlled error;
 * - a base64 data URL that reaches the mapper un-uploaded is a pipeline bug →
 *   controlled error pointing at the upload step;
 * - `files` / `tool_execution` response parts are preserved on the normalized
 *   surface (full fidelity) while the OpenAI surface carries the text.
 */
import { describe, expect, test } from "bun:test";
import { gigachatV2ToNormalized } from "../../../src/translation/gigachat-v2-to-normalized";
import { normalizedToGigaChatV2 } from "../../../src/translation/normalized-to-gigachat-v2";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";
import { imageContentRequest } from "../../fixtures/requests/openai";
import { filesV2Response } from "../../fixtures/responses/v2";

const noop = (): void => {};

describe("§24 multimodal zone — image wire contract", () => {
  test("HTTP(S) image URL → controlled error (upload to /v1/files required)", async () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    await expect(pipeline.chatRequest(imageContentRequest, "mm-sess")).rejects.toThrow(
      /HTTP\(S\) image URLs are not supported by GigaChat V2/,
    );
  });

  test("un-uploaded base64 data URL → controlled error at the mapper", () => {
    expect(() =>
      normalizedToGigaChatV2({
        model: "GigaChat-2-Max",
        messages: [
          {
            role: "user",
            content: [{ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }],
          },
        ],
      }),
    ).toThrow(/image data URL reached the V2 mapper un-uploaded/);
  });
});

describe("§24 multimodal zone — files response contract", () => {
  test("OpenCode surface keeps text; normalized surface preserves file parts", () => {
    const pipeline = createV2Pipeline({ onSseError: noop });
    const out = pipeline.jsonResponse(filesV2Response, "mm-sess");
    expect(out.choices[0].message.content).toBe("Here is your image:");
    expect(out.choices[0].message.tool_calls).toBeUndefined();

    const norm = gigachatV2ToNormalized(filesV2Response);
    expect(norm.choices[0].message.contentParts).toContainEqual({
      type: "file",
      id: "file-1",
      target: "image",
      mime: "image/png",
    });
    expect(norm.choices[0].message.contentParts).toContainEqual({
      type: "tool_result",
      name: "image_generate",
      result: JSON.stringify({ status: "success", seconds_left: 0, censored: false }),
    });
  });
});
