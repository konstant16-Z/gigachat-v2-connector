/**
 * PHASE 10 §23 — regression: Files API behavior parity.
 *
 * Origin: src/v2/translator.ts + src/v2/response.ts — V1 uploaded base64
 * content to `/v1/files` (purpose "general") and carried file references through
 * attachments. V2 does the same upload (src/v2/files.ts, live-verified
 * 2026-09-16) and carries file references as `content.files` items on the wire
 * and as file content parts in the normalized model.
 */
import { describe, expect, test } from "bun:test";
import type { ChatCompletionV2Response } from "../../../src/gigachat/v2/types";
import { gigachatV2ToNormalized } from "../../../src/translation/gigachat-v2-to-normalized";
import { normalizedToGigaChatV2 } from "../../../src/translation/normalized-to-gigachat-v2";

describe("§23 files — upload parity (content.files on the wire)", () => {
  test("file part → { files: [{ id }] } with target/mime dropped at the V2 wire", () => {
    const wire = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "here is the file" },
            { type: "file", id: "file-1", target: "image", mime: "image/png" },
          ],
        },
      ],
    });
    expect(wire.messages[0].content).toEqual([
      { text: "here is the file" },
      { files: [{ id: "file-1" }] },
    ]);
  });

  test("several file ids keep their order (multi-attachment parity)", () => {
    const wire = normalizedToGigaChatV2({
      model: "GigaChat-2-Max",
      messages: [
        {
          role: "user",
          content: [
            { type: "file", id: "a" },
            { type: "file", id: "b" },
            { type: "file", id: "c" },
          ],
        },
      ],
    });
    expect(wire.messages[0].content).toEqual([
      { files: [{ id: "a" }] },
      { files: [{ id: "b" }] },
      { files: [{ id: "c" }] },
    ]);
  });
});

describe("§23 files — response mapping parity (file items → file parts)", () => {
  test("JSON response content.files becomes a file content part with target/mime", () => {
    const response: ChatCompletionV2Response = {
      model: "GigaChat-2-Max",
      created_at: 1234,
      finish_reason: "stop",
      messages: [
        {
          role: "assistant",
          content: [
            { files: [{ id: "img-1", target: "image", mime: "image/png" }] },
            { text: "here it is" },
          ],
        },
      ],
    };
    const normalized = gigachatV2ToNormalized(response);
    expect(normalized.choices[0].message.contentParts).toContainEqual({
      type: "file",
      id: "img-1",
      target: "image",
      mime: "image/png",
    });
  });
});
