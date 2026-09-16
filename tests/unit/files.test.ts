/**
 * Unit tests: Files upload pre-processing (`uploadDataUrlsInRequest`).
 *
 * Offline paths only — no network:
 * - requests without data URLs pass through untouched (and are not re-uploaded);
 * - HTTP(S) URL image parts are left in place (mapper raises a controlled error);
 * - malformed base64 data URLs raise a controlled error with the underlying cause.
 */
import { describe, expect, test } from "bun:test";
import type { NormalizedRequest } from "../../src/core/types";
import { uploadDataUrlsInRequest } from "../../src/v2/files";

const requestWith = (
  content: NormalizedRequest["messages"][number]["content"],
): NormalizedRequest => ({
  model: "GigaChat-2-Max",
  messages: [{ role: "user", content }],
});

describe("uploadDataUrlsInRequest", () => {
  test("passes a request without data URLs through unchanged", async () => {
    const request = requestWith([
      { type: "text", text: "hello" },
      { type: "image", url: "https://example.com/pic.png" },
      { type: "file", id: "file-1" },
    ]);
    const result = await uploadDataUrlsInRequest(request, "token");
    expect(result).toEqual(request);
  });

  test("leaves HTTP(S) image URLs in place (mapper raises a controlled error later)", async () => {
    const request = requestWith([{ type: "image", url: "https://example.com/pic.png" }]);
    const result = await uploadDataUrlsInRequest(request, "token");
    expect(result.messages[0].content).toContainEqual({
      type: "image",
      url: "https://example.com/pic.png",
    });
  });

  test("raises a controlled error on a malformed base64 data URL", async () => {
    const request = requestWith([{ type: "image", url: "data:image/png;base64,!!not-base64!!" }]);
    await expect(uploadDataUrlsInRequest(request, "token")).rejects.toThrow(
      /failed to upload image data URL to GigaChat files/,
    );
  });
});
