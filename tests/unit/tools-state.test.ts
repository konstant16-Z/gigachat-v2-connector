/**
 * Unit tests: session-scoped tools_state_id store (plan §11).
 *
 * Acceptance:
 * - two sequential requests use the correct state;
 * - different sessions never mix state;
 * - concurrency (interleaved captures/applies) holds;
 * - no global mutable conversation state (store instances are independent).
 */
import { describe, expect, test } from "bun:test";
import type { NormalizedRequest, NormalizedResponse } from "../../src/core/types";
import {
  createToolStateStore,
  injectToolsState,
  latestToolsStateId,
  SessionToolStateStore,
} from "../../src/gigachat/v2/tools/state";

function requestWithTools(stateId?: string): NormalizedRequest {
  return {
    model: "GigaChat-2-Max",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        ...(stateId !== undefined ? { stateId } : {}),
      },
    ],
    tools: [{ name: "math", parameters: { type: "object" } }],
  };
}

function responseWithState(stateId?: string): NormalizedResponse {
  return {
    id: "r-1",
    created: 1,
    model: "GigaChat-2-Max",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "ok",
          contentParts: [],
          ...(stateId !== undefined ? { stateId } : {}),
        },
        finishReason: "stop",
      },
    ],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

describe("latestToolsStateId", () => {
  test("extracts from the latest choice that carries one", () => {
    expect(latestToolsStateId(responseWithState("state-1"))).toBe("state-1");
    expect(latestToolsStateId(responseWithState())).toBeUndefined();
  });

  test("last set wins across choices", () => {
    const response: NormalizedResponse = {
      ...responseWithState("first"),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", contentParts: [], stateId: "first" },
          finishReason: "stop",
        },
        {
          index: 1,
          message: { role: "assistant", content: "", contentParts: [], stateId: "latest" },
          finishReason: "stop",
        },
      ],
    };
    expect(latestToolsStateId(response)).toBe("latest");
  });
});

describe("injectToolsState", () => {
  test("injects into the last assistant message when tools are declared", () => {
    const out = injectToolsState(requestWithTools(), "state-injected");
    expect(out.messages[1].stateId).toBe("state-injected");
    expect(requestWithTools().messages[1].stateId).toBeUndefined(); // pure
  });

  test("never overrides a state the client already carries", () => {
    const out = injectToolsState(requestWithTools("state-client"), "state-store");
    expect(out.messages[1].stateId).toBe("state-client");
  });

  test("no-op without tools, without assistant message, or without state", () => {
    const noTools: NormalizedRequest = {
      model: "m",
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
    };
    expect(injectToolsState(noTools, "s")).toBe(noTools);

    const noAssistant: NormalizedRequest = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [{ name: "t", parameters: { type: "object" } }],
    };
    expect(injectToolsState(noAssistant, "s")).toBe(noAssistant);

    const plain = requestWithTools();
    expect(injectToolsState(plain, undefined)).toBe(plain);
  });
});

describe("SessionToolStateStore", () => {
  test("lifecycle: response state flows into the next request", () => {
    const store = createToolStateStore();
    store.captureFromResponse("s-1", responseWithState("state-a"));
    const next = store.applyToRequest("s-1", requestWithTools());
    expect(next.messages[1].stateId).toBe("state-a");
  });

  test("sequential requests: state is updated and reused", () => {
    const store = new SessionToolStateStore();
    store.capture("s-1", "state-v1");
    expect(store.applyToRequest("s-1", requestWithTools()).messages[1].stateId).toBe("state-v1");
    store.captureFromResponse("s-1", responseWithState("state-v2"));
    expect(store.applyToRequest("s-1", requestWithTools()).messages[1].stateId).toBe("state-v2");
  });

  test("sessions never mix state", () => {
    const store = createToolStateStore();
    store.capture("session-A", "state-A");
    store.capture("session-B", "state-B");
    expect(store.applyToRequest("session-A", requestWithTools()).messages[1].stateId).toBe(
      "state-A",
    );
    expect(store.applyToRequest("session-B", requestWithTools()).messages[1].stateId).toBe(
      "state-B",
    );
    expect(store.get("session-A")).toEqual({ toolsStateId: "state-A" });
    expect(store.get("session-B")).toEqual({ toolsStateId: "state-B" });
  });

  test("interleaved (concurrent-style) captures stay scoped per session", () => {
    const store = createToolStateStore();
    // Simulates racing responses for two sessions landing in any order.
    store.capture("A", "a-1");
    store.capture("B", "b-1");
    store.captureFromResponse("A", responseWithState("a-2"));
    store.capture("B", "b-2");
    expect(store.getToolsStateId("A")).toBe("a-2");
    expect(store.getToolsStateId("B")).toBe("b-2");
  });

  test("no global state: independent stores do not share sessions", () => {
    const one = createToolStateStore();
    const two = createToolStateStore();
    one.capture("s", "state-1");
    expect(two.getToolsStateId("s")).toBeUndefined();
    expect(one.size).toBe(1);
  });

  test("capture ignores undefined (no silent clearing)", () => {
    const store = createToolStateStore();
    store.capture("s", "state-1");
    store.capture("s", undefined);
    expect(store.getToolsStateId("s")).toBe("state-1");
  });

  test("delete and clear behave", () => {
    const store = createToolStateStore();
    store.capture("A", "x");
    store.capture("B", "y");
    store.delete("A");
    expect(store.getToolsStateId("A")).toBeUndefined();
    expect(store.getToolsStateId("B")).toBe("y");
    store.clear();
    expect(store.size).toBe(0);
  });
});
