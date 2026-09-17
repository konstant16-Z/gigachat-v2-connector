/**
 * GigaChat Files API client (live-verified 2026-09-16).
 *
 * Uploads base64 data-URL images/files to `/v1/files` and returns the file ID
 * for use in chat completions via `messages[].content.files`.
 */
import axios, { AxiosError } from "axios";
import { assertUploadSize, base64DecodedBytes } from "../core/attachments.js";
import { GIGACHAT_FILES_URL } from "./constants.js";
import { getHttpsAgent, shouldVerifySsl } from "./net.js";
import { sanitizeError } from "./net.js";

export interface UploadedFile {
  id: string;
  object: "file";
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  access_policy: string;
  modalities: string[];
}

/**
 * Upload a base64 data-URL (e.g. `data:image/png;base64,....`) to GigaChat Files.
 * Returns the file ID.
 *
 * Live-verified: POST https://api.giga.chat/v1/files with multipart/form-data
 * (file + purpose=general) → 200 with { id, object, bytes, ... }.
 */
export async function uploadBase64DataUrl(
  dataUrl: string,
  token: string,
): Promise<string> {
  // Parse data URL: data:<mime>;base64,<data>
  const matches = dataUrl.match(/^data:([A-Za-z0-9\-+./]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error("Invalid base64 data URL format");
  }
  const mimeType = matches[1];
  const dataString = matches[2];
  if (!mimeType || !dataString) {
    throw new Error("Invalid base64 data URL parts");
  }
  // Reject malformed base64 payloads locally (plan §30 — no network call for
  // garbage): strict alphabet with optional end padding; a residue of one
  // byte can never be a valid encoding.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataString) || dataString.length % 4 === 1) {
    throw new Error("Invalid base64 data URL payload");
  }
  // Enforce the documented per-attachment limit before decoding (plan §31:
  // oversized uploads must fail locally, not allocate or hit the network).
  assertUploadSize(mimeType, base64DecodedBytes(dataString));

  const buffer = Buffer.from(dataString, "base64");
  let ext = "png";
  if (mimeType.includes("jpeg")) ext = "jpg";
  else if (mimeType.includes("webp")) ext = "webp";
  else if (mimeType.includes("gif")) ext = "gif";
  else if (mimeType.includes("pdf")) ext = "pdf";

  const tempFileName = `upload_${Date.now()}.${ext}`;

  // Use native FormData (available in Bun)
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  form.append("file", blob, tempFileName);
  form.append("purpose", "general");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    // FormData will set Content-Type with boundary
  };

  const httpsAgent = getHttpsAgent(shouldVerifySsl(), "");

  try {
    const response = await axios.post<UploadedFile>(GIGACHAT_FILES_URL, form, {
      headers,
      httpsAgent,
      timeout: 30000,
    });
    return response.data.id;
  } catch (err) {
    throw sanitizeError(err);
  }
}

/**
 * Scan normalized messages for ImageParts with data URLs, upload them,
 * and replace with FileParts. Returns a new NormalizedRequest with files uploaded.
 *
 * This is an async pre-processing step for the V2 pipeline.
 */
import type { NormalizedRequest, NormalizedMessage, NormalizedContentPart } from "../core/types";

export async function uploadDataUrlsInRequest(
  request: NormalizedRequest,
  token: string,
): Promise<NormalizedRequest> {
  const messagesWithUploaded: NormalizedMessage[] = [];

  for (const msg of request.messages) {
    const newContent: NormalizedContentPart[] = [];
    for (const part of msg.content) {
      if (part.type === "image" && part.url.startsWith("data:")) {
        // No silent downgrade: if the upload fails, surface a controlled error
        // with the underlying cause instead of forwarding an unmappable part.
        const fileId = await uploadBase64DataUrl(part.url, token).catch(
          (err: unknown) => {
            const cause = err instanceof Error ? err.message : String(err);
            throw new Error(`failed to upload image data URL to GigaChat files: ${cause}`);
          },
        );
        newContent.push({ type: "file", id: fileId, target: "image" });
      } else {
        newContent.push(part);
      }
    }
    messagesWithUploaded.push({ ...msg, content: newContent });
  }

  return { ...request, messages: messagesWithUploaded };
}