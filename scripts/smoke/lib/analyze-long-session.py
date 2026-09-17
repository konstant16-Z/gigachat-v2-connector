#!/usr/bin/env python3
"""PHASE 12 §27 — long-session analyzer for the live smoke harness.

Reads the isolated scratch tree produced by ``scripts/smoke/run-long-session.sh``
(OpenCode session store + the capture plugin's outbound dump) and checks the
plan §27 checklist:

    tool IDs · tool state · context · streaming · reasoning · errors
    token usage · concurrency · cancellation

Evidence sources:

  <root>/data/opencode/opencode.db   session_v2 (counters) + session_message
                                     (assistant tool parts: ids, names,
                                     `functions_state_id`, `time.streamed`)
  <root>/logs/outbound-dump.log      capture-plugin lines: route, status,
                                     request size + state flag, response SSE /
                                     reasoning / usage flags

Exit code 0 when every HARD check passes; 1 otherwise. Soft checks (behaviour
the model or upstream may legitimately not produce in a given run) are reported
as WARN/INFO and only fail under ``--strict``.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

V2_URL = "https://api.giga.chat/v2/chat/completions"
CALL_ID_RE = re.compile(r"^call_\d+$")


def kv(line: str) -> dict[str, str]:
    """Parse the key=value pairs out of a dump line (values have no spaces)."""
    return dict(re.findall(r"([A-Za-z_]+)=(\S+)", line))


def parse_dump(path: Path) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    reqs: list[dict[str, str]] = []
    resps: list[dict[str, str]] = []
    if not path.exists():
        return reqs, resps
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if " REQ " in line:
            reqs.append(kv(line))
        elif " RESP " in line:
            resps.append(kv(line))
    return reqs, resps


def load_session(
    db: Path, session_id: str | None, title: str | None
) -> tuple[dict | None, list[dict]]:
    """Return (session_v2 row as dict, assistant message data list)."""
    if not db.exists():
        return None, []
    con = sqlite3.connect(db)
    try:
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        cols = (
            "id, title, tokens_input, tokens_output, tokens_reasoning,"
            " tokens_cache_read, tokens_cache_write, cost, model, time_created"
        )
        if session_id:
            row = cur.execute(
                f"SELECT {cols} FROM session_v2 WHERE id=?", (session_id,)
            ).fetchone()
        elif title:
            row = cur.execute(
                f"SELECT {cols} FROM session_v2 WHERE title LIKE ?"
                " ORDER BY time_created DESC LIMIT 1",
                (f"%{title}%",),
            ).fetchone()
        else:
            row = cur.execute(
                f"SELECT {cols} FROM session_v2 ORDER BY time_created DESC LIMIT 1"
            ).fetchone()
        if row is None:
            return None, []
        session = dict(row)
        msgs: list[dict] = []
        for data in cur.execute(
            "SELECT data FROM session_message WHERE session_id=? AND type='assistant'"
            " ORDER BY seq",
            (session["id"],),
        ).fetchall():
            try:
                msgs.append(json.loads(data[0]))
            except (TypeError, ValueError):
                continue
        return session, msgs
    finally:
        con.close()


def tool_parts(message: dict) -> list[dict]:
    content = message.get("content")
    if not isinstance(content, list):
        return []
    return [c for c in content if isinstance(c, dict) and c.get("type") == "tool"]


class Report:
    def __init__(self) -> None:
        self.hard_fail = 0
        self.soft_fail = 0
        self.checks: list[dict] = []

    def check(self, name: str, ok: bool, detail: str, hard: bool = True) -> None:
        status = "PASS" if ok else ("FAIL" if hard else "WARN")
        if not ok:
            if hard:
                self.hard_fail += 1
            else:
                self.soft_fail += 1
        self.checks.append({"name": name, "status": status, "detail": detail})
        print(f"  [{status}] {name}: {detail}")

    def info(self, name: str, detail: str) -> None:
        self.checks.append({"name": name, "status": "INFO", "detail": detail})
        print(f"  [INFO] {name}: {detail}")


def analyze(root: Path, session_id: str | None, title: str | None, min_tools: int, strict: bool) -> int:
    dump = root / "logs" / "outbound-dump.log"
    db = root / "data" / "opencode" / "opencode.db"
    reqs, resps = parse_dump(dump)
    session, messages = load_session(db, session_id, title)

    print(f">> §27 long-session analysis")
    print(f"   root:    {root}")
    print(f"   session: {(session or {}).get('id', '<none>')} — {(session or {}).get('title', '?')}")
    print(f"   dump:    {len(reqs)} REQ / {len(resps)} RESP")
    print()

    rep = Report()

    # ── tool interactions ───────────────────────────────────────────────────
    all_tools: list[dict] = []
    per_message_ids: list[list[str]] = []
    max_parallel = 0
    for message in messages:
        parts = tool_parts(message)
        ids = [str(p.get("id")) for p in parts]
        per_message_ids.append(ids)
        all_tools.extend(parts)
        max_parallel = max(max_parallel, len(parts))
    n_tools = len(all_tools)
    rep.check(
        "tool interactions ≥ min",
        n_tools >= min_tools,
        f"{n_tools} tool parts (min {min_tools})",
    )

    # ── tool IDs: stable sequential `call_<n>` per stream, exact per message ─
    bad_ids = [i for ids in per_message_ids for i in ids if not CALL_ID_RE.match(i)]
    seq_ok = all(
        ids == [f"call_{i + 1}" for i in range(len(ids))] for ids in per_message_ids if ids
    )
    rep.check("tool IDs well-formed (`call_<n>`)", not bad_ids, f"{len(bad_ids)} malformed")
    rep.check(
        "tool IDs sequential within each message",
        seq_ok,
        "each assistant message: call_1..call_N",
    )

    # ── concurrency: ≥1 assistant message with two+ parallel tool calls ─────
    rep.check(
        "parallel tool calls (concurrency)",
        max_parallel >= 2,
        f"max {max_parallel} tool calls in one assistant message",
        hard=False,
    )

    # ── streaming: OpenCode marks each assistant message as streamed ────────
    streamed = sum(1 for m in messages if (m.get("time") or {}).get("streamed"))
    sse_resps = sum(1 for r in resps if r.get("sse") == "yes")
    rep.check(
        "streaming path exercised",
        streamed > 0 or sse_resps > 0,
        f"{streamed}/{len(messages)} assistant messages streamed, {sse_resps} SSE responses",
    )

    # ── tool state: connector injects state on follow-up requests ───────────
    state_reqs = sum(1 for r in reqs if r.get("fstate") == "yes")
    rep.check(
        "tool state round-trip (`functions_state_id`)",
        state_reqs >= 2,
        f"{state_reqs} requests carried a state token",
        hard=False,
    )

    # ── context: request body grows as history accumulates ─────────────────
    sizes = [int(r["bytes"]) for r in reqs if r.get("bytes", "").isdigit()]
    if len(sizes) >= 3:
        grew = sizes[-1] > sizes[0] and max(sizes) >= sizes[len(sizes) // 2]
        rep.check(
            "context accumulation (wire size grows)",
            grew,
            f"first={sizes[0]} max={max(sizes)} last={sizes[-1]} bytes",
        )
    else:
        rep.check("context accumulation (wire size grows)", False, f"only {len(sizes)} REQ sizes")

    # ── route + status: hard evidence the V2 pipeline carried the traffic ───
    bad_routes = [r for r in reqs if r.get("url") != V2_URL]
    rep.check(
        "V2 route on every request",
        bool(reqs) and not bad_routes,
        f"{len(reqs) - len(bad_routes)}/{len(reqs)} to /v2/chat/completions",
    )
    bad_status = [r for r in resps if r.get("status") != "200"]
    rep.check(
        "all upstream responses 200",
        bool(resps) and not bad_status,
        f"{len(resps) - len(bad_status)}/{len(resps)} 200",
    )

    # ── reasoning / usage surfacing (soft: model-dependent) ────────────────
    reasoning_resps = sum(1 for r in resps if r.get("reasoning") == "yes")
    usage_resps = sum(1 for r in resps if r.get("usage") == "yes")
    rep.check(
        "reasoning content observed",
        reasoning_resps > 0,
        f"{reasoning_resps}/{len(resps)} responses contained `reasoning_content`",
        hard=False,
    )
    rep.check(
        "usage present upstream",
        usage_resps > 0,
        f"{usage_resps}/{len(resps)} responses contained `usage`",
        hard=False,
    )
    rep.info(
        "session token counters",
        f"in={session.get('tokens_input') if session else '?'} "
        f"out={session.get('tokens_output') if session else '?'} "
        f"reasoning={session.get('tokens_reasoning') if session else '?'}",
    )

    print()
    hard = rep.hard_fail
    soft = rep.soft_fail
    print(f"================================================================")
    print(f" hard FAIL: {hard}   soft WARN: {soft}   tools: {n_tools}")
    print(f"================================================================")

    summary = {
        "session": (session or {}).get("id"),
        "title": (session or {}).get("title"),
        "tool_parts": n_tools,
        "max_parallel": max_parallel,
        "requests": len(reqs),
        "responses": len(resps),
        "state_requests": state_reqs,
        "sse_responses": sse_resps,
        "reasoning_responses": reasoning_resps,
        "usage_responses": usage_resps,
        "wire_sizes": sizes,
        "hard_fail": hard,
        "soft_fail": soft,
        "checks": rep.checks,
    }
    (root / "logs" / "long-session-analysis.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )

    if hard > 0:
        return 1
    if strict and soft > 0:
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="§27 long-session analyzer")
    ap.add_argument("--root", default="/tmp/opencode/gigachat-smoke")
    ap.add_argument("--session-id", default=None)
    ap.add_argument("--title", default="long-session")
    ap.add_argument("--min-tools", type=int, default=20)
    ap.add_argument("--strict", action="store_true", help="soft checks become failures")
    args = ap.parse_args()
    return analyze(Path(args.root), args.session_id, args.title, args.min_tools, args.strict)


if __name__ == "__main__":
    sys.exit(main())
