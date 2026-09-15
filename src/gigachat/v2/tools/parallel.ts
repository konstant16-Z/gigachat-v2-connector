/**
 * Parallel tool-call linkage (plan §10 "parallel").
 *
 * Tool identity MUST hold across a request/response cycle:
 *
 *   OpenCode tool_call_id → GigaChat tool call → tool result → OpenCode tool_call_id
 *
 * The forbidden case is `tool_1 → result_2`. V2 function_call parts carry no
 * id (documented), so linkage on the request side relies on the stable ids of
 * prior assistant tool calls. This module is the single place that verifies
 * and resolves that linkage (plan: "вынести mapping/state в отдельный модуль").
 *
 * - orphan: a result whose tool_call_id is unknown / unresolved → error;
 * - duplicate: two results for the same call → error;
 * - missing: a call without any result → informational (may be legal: a new
 *   turn may continue with the assistant tool-call message only).
 */
import type { ToolCallRef } from "./normalize";

/** A tool_result part to be linked against prior assistant calls. */
export interface ToolResultRef {
  /** Position of this result among the message's tool_result parts. */
  index: number;
  toolCallId?: string;
  name?: string;
}

/** A result successfully linked to a prior call (or carried by explicit name). */
export interface LinkedToolResult {
  index: number;
  callId?: string;
  name: string;
}

export interface ToolLinkage {
  /** Results in input order, each with the resolved function name. */
  linked: LinkedToolResult[];
  /** Prior call ids that received no result in this message. */
  missingCalls: string[];
  /** Result positions whose tool_call_id was matched more than once. */
  duplicateResults: Array<{ index: number; toolCallId?: string; name?: string }>;
  /** Result positions that could not be resolved to any call. */
  orphanResults: Array<{ index: number; toolCallId?: string; name?: string }>;
}

export function verifyToolLinkage(calls: ToolCallRef[], results: ToolResultRef[]): ToolLinkage {
  const linked: LinkedToolResult[] = [];
  const matched = new Set<string>();
  const duplicateResults: ToolLinkage["duplicateResults"] = [];
  const orphanResults: ToolLinkage["orphanResults"] = [];

  for (const r of results) {
    if (r.toolCallId === undefined) {
      // Legacy-style result carrying an explicit name: no id to verify against.
      if (r.name !== undefined) {
        linked.push({ index: r.index, name: r.name });
      } else {
        orphanResults.push({ index: r.index });
      }
      continue;
    }
    const call = calls.find((c) => c.id === r.toolCallId);
    if (!call) {
      orphanResults.push({ index: r.index, toolCallId: r.toolCallId, name: r.name });
      continue;
    }
    if (matched.has(r.toolCallId)) {
      duplicateResults.push({ index: r.index, toolCallId: r.toolCallId, name: r.name });
      continue;
    }
    matched.add(r.toolCallId);
    linked.push({ index: r.index, callId: r.toolCallId, name: call.name });
  }

  const missingCalls = calls.filter((c) => !matched.has(c.id)).map((c) => c.id);
  return { linked, missingCalls, duplicateResults, orphanResults };
}
