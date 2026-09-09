/**
 * Host/provider detection helpers.
 */
import { GIGACHAT_COMPLETIONS_URL, GIGACHAT_FILES_URL, log } from "./constants.js";

export const gigaHosts = new Set<string>([
  "api.gigachat.local",
  "ngw.devices.sberbank.ru",
  "ngw.devices.sberbank.ru:9443",
  "gigachat.devices.sberbank.ru"
]);

/** Register an additional GigaChat-compatible endpoint host. */
export function registerGigaEndpoint(url?: string): void {
  if (!url) return;
  try {
    let hostVal = "";
    if (url.startsWith("http://") || url.startsWith("https://")) {
      hostVal = new URL(url).host;
    } else {
      hostVal = new URL("https://" + url).host;
    }
    if (hostVal) {
      gigaHosts.add(hostVal);
      log(`Registered custom GigaChat host: ${hostVal}`);
    }
  } catch {
    const cleaned = url.replace(/https?:\/\//, "").split("/")[0];
    if (cleaned) {
      gigaHosts.add(cleaned);
      log(`Registered custom GigaChat host (fallback): ${cleaned}`);
    }
  }
}

/** Whether a provider id refers to a GigaChat-family provider. */
export function isGigaProvider(providerID?: string): boolean {
  if (!providerID) return false;
  const id = providerID.toLowerCase();
  return (
    id === "gigachat" ||
    id === "gigacode" ||
    id.includes("gigachat") ||
    id.includes("gigacode") ||
    id.includes("sberbank") ||
    id.includes("сбербанк")
  );
}

export function tryHost(requestUrl?: string): string | undefined {
  try {
    const u = new URL(requestUrl || "");
    return u.host;
  } catch {
    return undefined;
  }
}

/** Rewrite the local dev endpoint to the real GigaChat API. */
export function targetUrlFor(requestUrl: string, isChat: boolean, isFiles: boolean): string {
  const host = tryHost(requestUrl);
  if (host === "api.gigachat.local") {
    if (isChat) return GIGACHAT_COMPLETIONS_URL;
    if (isFiles) return GIGACHAT_FILES_URL;
    return requestUrl.replace("api.gigachat.local/v1", "ngw.devices.sberbank.ru:9443/api/v2");
  }
  return requestUrl;
}