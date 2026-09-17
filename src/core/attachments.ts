/**
 * Attachment upload limits (plan §31: "oversized uploads").
 *
 * The GigaChat Files API constrains individual attachment sizes
 * (`docs/external/gigachat-api.yml`): image 15 MB, audio 35 MB, text 40 MB;
 * the combined request must stay under 80 MB. The connector decodes base64
 * data URLs in memory, so an unbounded payload is both a memory hazard and a
 * guaranteed upstream 4xx. Limits are therefore enforced *before* decoding.
 */

/** Maximum decoded size of a single image attachment (spec: 15 MB). */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** Maximum decoded size of a single audio attachment (spec: 35 MB). */
export const MAX_AUDIO_BYTES = 35 * 1024 * 1024;
/** Maximum decoded size of a single text/other attachment (spec: 40 MB). */
export const MAX_TEXT_BYTES = 40 * 1024 * 1024;

/** Decoded-size limit for a data URL of the given MIME type. */
export function maxUploadBytes(mimeType: string): number {
  if (mimeType.startsWith("image/")) return MAX_IMAGE_BYTES;
  if (mimeType.startsWith("audio/")) return MAX_AUDIO_BYTES;
  return MAX_TEXT_BYTES;
}

/**
 * Decoded byte length of a base64 string, computed without allocating the
 * decoded buffer (so the limit is enforced before `Buffer.from`).
 */
export function base64DecodedBytes(base64: string): number {
  if (base64.length === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Throw a controlled error when an attachment exceeds the documented limit. */
export function assertUploadSize(mimeType: string, byteLength: number): void {
  const limit = maxUploadBytes(mimeType);
  if (byteLength > limit) {
    throw new Error(
      `attachment too large: ${mimeType} is ${byteLength} bytes, ` +
        `the GigaChat limit is ${limit} bytes ` +
        "(docs/external/gigachat-api.yml: image 15 MB, audio 35 MB, text 40 MB)",
    );
  }
}
