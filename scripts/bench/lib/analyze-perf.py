#!/usr/bin/env python3
"""PHASE 12 §33 — aggregate live performance captures into a table.

Reads one or more JSONL files produced by scripts/bench/perf-plugin
(`{mode,scenario,status,sse,ttft_ms,total_ms,out_bytes,out_tokens,usage,
usage_source,estimate_tokens,probe_usage,tokens_per_sec,...}`), groups by
(mode, scenario) and reports latency/tokens percentiles and the usage-source
breakdown. Writes logs/perf-analysis.json.

Usage:
  scripts/bench/lib/analyze-perf.py FILE.jsonl [FILE2.jsonl ...]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def percentile(sorted_values: list[float], pct: float) -> float:
    if not sorted_values:
        return float("nan")
    if len(sorted_values) == 1:
        return sorted_values[0]
    idx = min(len(sorted_values) - 1, int(round((pct / 100) * (len(sorted_values) - 1))))
    return sorted_values[idx]


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else float("nan")


def load(paths: list[str]) -> list[dict]:
    records: list[dict] = []
    bad = 0
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    bad += 1
    if bad:
        print(f">> skipped {bad} malformed line(s)", file=sys.stderr)
    return records


def summarize(records: list[dict]) -> dict:
    # Latency and token aggregates ignore failed responses (HTTP >= 400):
    # their timing is a retry artifact and the connector never surfaced their
    # tokens. They still count toward `count`/`errors` for transparency.
    ok = [
        r
        for r in records
        if not (isinstance(r.get("status"), int) and r["status"] >= 400)
    ]
    ttft = sorted(r["ttft_ms"] for r in ok if r.get("ttft_ms") is not None)
    total = sorted(r["total_ms"] for r in ok if r.get("total_ms") is not None)
    tps = sorted(
        r["tokens_per_sec"] for r in ok if r.get("tokens_per_sec") is not None
    )
    tokens = [r["out_tokens"] for r in ok if r.get("out_tokens") is not None]
    estimates = [
        r["estimate_tokens"] for r in ok if r.get("estimate_tokens") is not None
    ]
    sources: dict[str, int] = {}
    for r in records:
        key = str(r.get("usage_source", "?"))
        sources[key] = sources.get(key, 0) + 1
    return {
        "count": len(records),
        "ok": len(ok),
        "sse": sum(1 for r in records if r.get("sse")),
        "ttft_ms": {"mean": mean(ttft), "p50": percentile(ttft, 50), "p95": percentile(ttft, 95)},
        "total_ms": {
            "mean": mean(total),
            "p50": percentile(total, 50),
            "p95": percentile(total, 95),
        },
        "tokens_per_sec": {
            "mean": mean(tps),
            "p50": percentile(tps, 50),
            "p95": percentile(tps, 95),
        },
        "out_tokens": {"mean": mean(tokens), "p50": percentile(sorted(tokens), 50)},
        "estimate_tokens": {
            "mean": mean(estimates),
            "p50": percentile(sorted(estimates), 50),
        },
        "usage_sources": sources,
        "errors": sum(1 for r in records if isinstance(r.get("status"), int) and r["status"] >= 400),
    }


def fmt_sources(sources: dict[str, int]) -> str:
    return " ".join(f"{key}:{value}" for key, value in sorted(sources.items()))


def fmt(value: float, digits: int = 0) -> str:
    if value != value:  # NaN
        return "–"
    return f"{value:.{digits}f}"


def main() -> int:
    paths = sys.argv[1:]
    if not paths:
        print(__doc__, file=sys.stderr)
        return 2
    records = load(paths)
    if not records:
        print("ERROR: no records found", file=sys.stderr)
        return 1

    # Drop records from harness runs cut off by the wall-clock cap: their
    # repeated responses are an agent/tool loop, not a scenario measurement.
    excluded_runs = {
        run for run in os.environ.get("PERF_EXCLUDE_RUNS", "").split(",") if run
    }
    if excluded_runs:
        dropped = sum(1 for r in records if str(r.get("run_id")) in excluded_runs)
        records = [
            r for r in records if str(r.get("run_id")) not in excluded_runs
        ]
        print(
            f">> excluded {dropped} record(s) from capped run(s): "
            f"{', '.join(sorted(excluded_runs))}",
            file=sys.stderr,
        )
    if not records:
        print("ERROR: no records left after exclusions", file=sys.stderr)
        return 1

    groups: dict[tuple[str, str], list[dict]] = {}
    for record in records:
        key = (str(record.get("mode", "?")), str(record.get("scenario", "?")))
        groups.setdefault(key, []).append(record)

    analysis = {}
    for (mode, scenario), rows in sorted(groups.items()):
        analysis.setdefault(mode, {})[scenario] = summarize(rows)

    print("# Live performance (plan §33)\n")
    print(
        "| Mode | Scenario | n | ok | sse | TTFT p50 ms | TTFT p95 ms | Total p50 ms | "
        "Total p95 ms | tok/s p50 | out tok p50 | errors | usage src |"
    )
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for mode, scenarios in analysis.items():
        for scenario, s in scenarios.items():
            print(
                f"| {mode} | {scenario} | {s['count']} | {s['ok']} | {s['sse']} | "
                f"{fmt(s['ttft_ms']['p50'], 1)} | {fmt(s['ttft_ms']['p95'], 1)} | "
                f"{fmt(s['total_ms']['p50'], 1)} | {fmt(s['total_ms']['p95'], 1)} | "
                f"{fmt(s['tokens_per_sec']['p50'], 1)} | {fmt(s['out_tokens']['p50'], 0)} | "
                f"{s['errors']} | {fmt_sources(s['usage_sources'])} |"
            )

    out = Path(os.environ.get("PERF_ANALYSIS", "logs/perf-analysis.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(analysis, indent=2) + "\n", encoding="utf-8")
    print(f"\n>> JSON written: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
