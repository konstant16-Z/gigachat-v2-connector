/**
 * Session-scoped `tools_state_id` store (plan §11 "tools_state_id").
 *
 * Lifecycle:
 *
 *   response → extract tools_state_id → store → next request → tool_state_id
 *
 * The spec (docs/external/gigachat-api.yml, Message.tool_state_id): the id
 * arrives on an assistant message of the response, must be sent back inside an
 * **assistant** message of the next request, and only makes sense when tools
 * are declared. Storage is in-memory and **instance-scoped** — one store per
 * integration, keyed by session id; no global mutable conversation state
 * (agents.md §14). `injectToolsState` is pure (returns a shallow copy) and
 * never overrides a state the client already round-tripped through history.
 */
import type { NormalizedRequest, NormalizedResponse } from "../../../core/types";

export interface GigaChatSessionState {
  /** Latest `tools_state_id` returned by the model for this session. */
  toolsStateId?: string;
}

export class SessionToolStateStore {
  private readonly sessions = new Map<string, GigaChatSessionState>();

  /** Number of tracked sessions (diagnostics/tests). */
  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): GigaChatSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  getToolsStateId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.toolsStateId;
  }

  set(sessionId: string, state: GigaChatSessionState): void {
    this.sessions.set(sessionId, { ...state });
  }

  /** Record a captured state id; `undefined` is a no-op (no silent clearing). */
  capture(sessionId: string, toolsStateId: string | undefined): void {
    if (toolsStateId === undefined) return;
    const current = this.sessions.get(sessionId) ?? {};
    this.sessions.set(sessionId, { ...current, toolsStateId });
  }

  /** Response side of the lifecycle: extract and store the session state. */
  captureFromResponse(sessionId: string, response: NormalizedResponse): void {
    this.capture(sessionId, latestToolsStateId(response));
  }

  /** Request side of the lifecycle: apply the session state (pure). */
  applyToRequest(sessionId: string, request: NormalizedRequest): NormalizedRequest {
    return injectToolsState(request, this.getToolsStateId(sessionId));
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }
}

export function createToolStateStore(): SessionToolStateStore {
  return new SessionToolStateStore();
}

/** Latest `tools_state_id` across response choices (last set wins). */
export function latestToolsStateId(response: NormalizedResponse): string | undefined {
  let latest: string | undefined;
  for (const choice of response.choices) {
    if (choice.message.stateId !== undefined) latest = choice.message.stateId;
  }
  return latest;
}

/**
 * Inject a state id into the next request. Pure: returns a new request object
 * only when an injection actually happens.
 *
 * Rules (documented): only when (1) a state id exists, (2) the request
 * declares tools (the id "объединяет массив инструментов tools"), (3) there
 * is an assistant message, and (4) it does not already carry a state — the
 * client-owned history value is authoritative.
 */
export function injectToolsState(
  request: NormalizedRequest,
  toolsStateId: string | undefined,
): NormalizedRequest {
  if (toolsStateId === undefined) return request;
  if ((request.tools?.length ?? 0) === 0) return request;
  const lastAssistant = lastAssistantIndex(request.messages);
  if (lastAssistant === -1) return request;
  const message = request.messages[lastAssistant];
  if (message.stateId !== undefined) return request;
  const messages = request.messages.slice();
  messages[lastAssistant] = { ...message, stateId: toolsStateId };
  return { ...request, messages };
}

function lastAssistantIndex(messages: NormalizedRequest["messages"]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") return i;
  }
  return -1;
}
