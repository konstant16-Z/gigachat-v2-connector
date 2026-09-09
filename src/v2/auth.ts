/**
 * OAuth2 token management for the GigaChat API.
 */
import axios from "axios";
import { v4 } from "uuid";
import { GIGACHAT_OAUTH_URL, DEFAULT_CA_BUNDLE_FILE, REFRESH_BUFFER_SECONDS, log, error } from "./constants.js";
import { getHttpsAgent, sanitizeError, shouldVerifySsl } from "./net.js";

type Scope = "GIGACHAT_API_PERS" | "GIGACHAT_API_B2B" | "GIGACHAT_API_CORP";

interface GigaChatAccount {
  id: string;
  name: string;
  credentials: string;
  scope: Scope;
}

interface TokenCache {
  accessToken: string;
  expiresAtSeconds: number;
}

export class GigaCodeAuthManager {
  private credentialsValue: string | null = null;
  private scopeValue: Scope = "GIGACHAT_API_PERS";
  private verifySslValue?: boolean;
  private caBundleValue?: string;
  private tokenCache: TokenCache | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor() {
    if (process.env.GIGACHAT_CREDENTIALS) {
      this.credentialsValue = process.env.GIGACHAT_CREDENTIALS;
      const envScope = process.env.GIGACHAT_SCOPE;
      if (envScope === "GIGACHAT_API_B2B" || envScope === "GIGACHAT_API_CORP" || envScope === "GIGACHAT_API_PERS") {
        this.scopeValue = envScope;
      }
      log("Loaded GigaChat credentials from environment variables.");
    }
  }

  setCredentials(credentials: string, scope?: string, verifySsl?: boolean, caBundle?: string): void {
    const cleanCredentials = credentials ? credentials.trim() : "";
    let cleanScope: Scope = "GIGACHAT_API_PERS";
    if (scope) {
      const trimmedScope = scope.trim();
      if (trimmedScope === "GIGACHAT_API_B2B" || trimmedScope === "GIGACHAT_API_CORP" || trimmedScope === "GIGACHAT_API_PERS") {
        cleanScope = trimmedScope;
      }
    }
    if (
      this.credentialsValue !== cleanCredentials ||
      this.scopeValue !== cleanScope ||
      this.verifySslValue !== verifySsl ||
      this.caBundleValue !== caBundle
    ) {
      this.credentialsValue = cleanCredentials;
      this.scopeValue = cleanScope;
      this.verifySslValue = verifySsl;
      this.caBundleValue = caBundle;
      this.tokenCache = null;
      this.refreshPromise = null;
      log("Dynamic credentials configured from plugin options.");
    }
  }

  getVerifySsl(): boolean {
    if (this.verifySslValue !== undefined) return this.verifySslValue;
    return shouldVerifySsl();
  }

  getCaBundle(): string {
    return this.caBundleValue || process.env.GIGACHAT_CA_BUNDLE_FILE || DEFAULT_CA_BUNDLE_FILE;
  }

  hasCredentials(): boolean {
    return !!this.credentialsValue || !!process.env.GIGACHAT_CREDENTIALS;
  }

  getActiveAccount(): GigaChatAccount | null {
    if (!this.credentialsValue) {
      if (process.env.GIGACHAT_CREDENTIALS) {
        this.credentialsValue = process.env.GIGACHAT_CREDENTIALS;
        const envScope = process.env.GIGACHAT_SCOPE;
        if (envScope === "GIGACHAT_API_B2B" || envScope === "GIGACHAT_API_CORP" || envScope === "GIGACHAT_API_PERS") {
          this.scopeValue = envScope;
        }
      }
    }
    if (!this.credentialsValue) return null;
    return {
      id: "default-gigacode-account",
      name: "GigaChat Account",
      credentials: this.credentialsValue,
      scope: this.scopeValue
    };
  }

  /** Currently only logs; a real multi-account setup can switch accounts here. */
  blockActiveAccount(reason: string): void {
    error(`Active account warning / rate-limit encountered: ${reason}`);
  }

  async getAccessToken(): Promise<{ token: string; account: GigaChatAccount }> {
    const account = this.getActiveAccount();
    if (!account) {
      throw new Error(
        "GigaChat credentials are not configured. " +
          "Provide 'credentials' via the gigacode plugin options in opencode.json, " +
          "or set the GIGACHAT_CREDENTIALS environment variable."
      );
    }
    const currentSeconds = Date.now() / 1000;
    if (this.tokenCache && currentSeconds < this.tokenCache.expiresAtSeconds - REFRESH_BUFFER_SECONDS) {
      return { token: this.tokenCache.accessToken, account };
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchToken(account).finally(() => {
        this.refreshPromise = null;
      });
    }
    try {
      const token = await this.refreshPromise;
      return { token, account };
    } catch (err) {
      throw sanitizeError(err);
    }
  }

  private async fetchToken(account: GigaChatAccount): Promise<string> {
    const url = GIGACHAT_OAUTH_URL;
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${account.credentials}`,
      RqUID: v4()
    };
    const body = new URLSearchParams({ scope: account.scope }).toString();
    const caBundle = this.getCaBundle();
    const verifySsl = this.getVerifySsl();
    const httpsAgent = getHttpsAgent(verifySsl, caBundle);
    try {
      log(`Exchanging token for account: ${account.name}...`);
      const response = await axios.post(url, body, {
        headers,
        httpsAgent,
        timeout: 10000
      });
      const token: string = response.data.access_token || response.data.tok;
      if (!token) {
        throw new Error("No token returned in auth response");
      }
      const expiresAtRaw: number =
        response.data.expires_at !== undefined ? response.data.expires_at : response.data.exp || 0;
      const expiresAtSeconds = expiresAtRaw > 1000000000000 ? expiresAtRaw / 1000 : expiresAtRaw;
      this.tokenCache = {
        accessToken: token,
        expiresAtSeconds
      };
      return token;
    } catch (err) {
      error(`Token exchange failed for ${account.name}:`, err instanceof Error ? err.message : String(err));
      throw sanitizeError(err);
    }
  }
}

export const authManager = new GigaCodeAuthManager();