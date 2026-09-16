/**
 * PHASE 10 §23 — regression: image content keeps the documented V2 behavior.
 *
 * Origin: src/v2/translator.ts §5/§15 — V1 uploaded base64 `data:image/...`
 * URLs via the Files API and replaced HTTP(S) URLs with an "[Image URL: …]"
 * text placeholder. V2 keeps the V1 *upload* path (uploadDataUrlsInRequest →
 * /v1/files, live-verified 2026-09-16) but replaces the silent placeholder
 * with a controlled error (agents.md RULE 13: no silent translation).
 */
import { describe, expect, test } from "bun:test";
import { normalizedToGigaChatV2 } from "../../../src/translation/normalized-to-gigachat-v2";
import { openCodeToNormalized } from "../../../src/translation/opencode-to-normalized";
import { createV2Pipeline } from "../../../src/translation/v2-pipeline";

describe("§23 vision — image content mapping parity", () => {
  test("HTTP(S) image URL → controlled error (V1 placeholder is a silent drop, now refused)", async () => {
    const pipeline = createV2Pipeline();
    await expect(
      pipeline.chatRequest(
        {
          model: "GigaChat-2-Max",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look" },
                { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
              ],
            },
          ],
        },
        "s-vision-1",
      ),
    ).rejects.toThrow(/HTTP\(S\) image URLs are not supported by GigaChat V2/);
  });

  test("un-uploaded base64 data URL → controlled error pointing at the pipeline step", () => {
    // Bypass chatRequest (which uploads data URLs); force the raw mapper path.
    const normalized = openCodeToNormalized({
      model: "GigaChat-2-Max",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      ],
    });
    expect(() => normalizedToGigaChatV2(normalized)).toThrow(
      /image data URL reached the V2 mapper un-uploaded/,
    );
  });

  test("files-uploaded image travels as content.files on the wire", () => {
    const wire = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [
        {
          role: "user",
          content: [{ type: "file", id: "file-abc", target: "image" }],
        },
      ],
    });
    expect(wire.messages[0].content).toEqual([{ files: [{ id: "file-abc" }] }]);
  });
});
