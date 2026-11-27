#!/usr/bin/env python3
"""Pyria Periodic Trial Calibration Report CLI (GitHub Issue #70).

Generates a Markdown or CSV calibration summary from either:
  - A local SQLite database (`--db data/pyria.sqlite3`), OR
  - A JSON export from `GET /api/admin/trial-metrics` (`--input metrics.json`).

Examples:
  python3 scripts/calibration_report.py --db data/pyria.sqlite3 --days 30
  python3 scripts/calibration_report.py --input metrics.json --compare-cutoff 2026-05-01
  npm run calibration-report -- --db data/pyria.sqlite3 --format csv
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = REPO_ROOT / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from app import (  # noqa: E402
    VALID_DAYS_FILTERS,
    VALID_DIFFICULTY_FILTERS,
    compute_trial_metrics_from_conn,
    extract_trial_catalog,
    format_trial_metrics_csv,
    is_valid_iso_date,
)


def load_catalog_from_content_dir(content_dir: Path) -> list[dict[str, Any]]:
    game_path = content_dir / "game.json"
    if not game_path.is_file():
        return []
    try:
        game = json.loads(game_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    eras_dir = content_dir / "eras"
    ordered_ids: list[str] = list(game.get("eraOrder") or [])
    if eras_dir.is_dir():
        for p in sorted(eras_dir.glob("*.json")):
            if not p.name.startswith(".") and p.stem not in ordered_ids:
                ordered_ids.append(p.stem)
    eras: list[dict[str, Any]] = []
    for era_id in ordered_ids:
        era_path = eras_dir / f"{era_id}.json"
        if era_path.is_file():
            try:
                eras.append(json.loads(era_path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
    return extract_trial_catalog(eras)


def _fmt_pct(val: float | int | None) -> str:
    return f"{val:.1f}%" if val is not None else "—"


def _fmt_num(val: float | int | None) -> str:
    return f"{val:.1f}" if val is not None else "—"


def _md_escape(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def _compare_from_json_trends(
    trials: list[dict[str, Any]], cutoff: str
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for t in trials:
        trend = t.get("dailyTrend") or []
        before_att = 0
        before_pass = 0
        after_att = 0
        after_pass = 0
        for pt in trend:
            day = str(pt.get("day") or "")
            att = int(pt.get("attempts") or 0)
            pas = int(pt.get("passes") or 0)
            if day < cutoff:
                before_att += att
                before_pass += pas
            else:
                after_att += att
                after_pass += pas
        if before_att > 0 and after_att > 0:
            before_rate = round((before_pass / before_att) * 100.0, 1)
            after_rate = round((after_pass / after_att) * 100.0, 1)
            rows.append(
                {
                    "trialId": t.get("trialId", ""),
                    "title": t.get("title", ""),
                    "beforeAttempts": before_att,
                    "afterAttempts": after_att,
                    "beforeRate": before_rate,
                    "afterRate": after_rate,
                    "delta": round(after_rate - before_rate, 1),
                    "metricLabel": "Pass Rate",
                }
            )
    rows.sort(key=lambda r: abs(r["delta"]), reverse=True)
    return rows


def _compare_from_sqlite(
    conn: sqlite3.Connection,
    catalog: list[dict[str, Any]],
    base_filters: dict[str, Any],
    cutoff: str,
) -> list[dict[str, Any]]:
    before_filters = {**base_filters, "days": "all", "since": None}
    after_filters = {**base_filters, "since": cutoff}
    before_metrics = compute_trial_metrics_from_conn(
        conn, catalog, before_filters, max_day=cutoff
    )
    after_metrics = compute_trial_metrics_from_conn(conn, catalog, after_filters)
    before_by_id = {t["trialId"]: t for t in before_metrics["trials"]}
    rows: list[dict[str, Any]] = []
    for after_t in after_metrics["trials"]:
        tid = after_t["trialId"]
        before_t = before_by_id.get(tid)
        if not before_t:
            continue
        if before_t["attempts"] > 0 and after_t["attempts"] > 0:
            b_rate = before_t["completionRate"]
            a_rate = after_t["completionRate"]
            delta = (
                round(a_rate - b_rate, 1)
                if (b_rate is not None and a_rate is not None)
                else 0.0
            )
            rows.append(
                {
                    "trialId": tid,
                    "title": after_t["title"],
                    "beforeAttempts": before_t["attempts"],
                    "afterAttempts": after_t["attempts"],
                    "beforeRate": b_rate,
                    "afterRate": a_rate,
                    "delta": delta,
                    "metricLabel": "Completion Rate",
                }
            )
    rows.sort(key=lambda r: abs(r["delta"]), reverse=True)
    return rows


def render_markdown_report(
    metrics: dict[str, Any],
    *,
    compare_cutoff: str | None = None,
    compare_rows: list[dict[str, Any]] | None = None,
) -> str:
    summary = metrics.get("summary") or {}
    filters = metrics.get("filters") or {}
    trials = list(metrics.get("trials") or [])
    with_data = [t for t in trials if (t.get("attempts") or 0) > 0 or (t.get("parentOverrides") or 0) > 0]

    lines: list[str] = [
        "# Pyria Trial Calibration Report",
        "",
        f"- **Difficulty:** `{filters.get('difficulty', 'all')}` | **Window:** `{filters.get('since') or (str(filters.get('days', '30')) + 'd')}` | **Min Heroes:** `{filters.get('minHeroes', 5)}` | **Include Practice:** `{bool(filters.get('includePractice', False))}`",
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
        f"| Total Trials | {summary.get('totalTrials', len(trials))} |",
        f"| Trials with Data | {summary.get('trialsWithData', len(with_data))} |",
        f"| Flagged Too Hard | {summary.get('flaggedTooHard', 0)} |",
        f"| Flagged Too Easy | {summary.get('flaggedTooEasy', 0)} |",
        f"| Flagged Possible Bug | {summary.get('flaggedPossibleBug', 0)} |",
        f"| Flagged Low Data | {summary.get('flaggedLowData', 0)} |",
        f"| Overall Median Attempts | {_fmt_num(summary.get('overallMedianAttempts'))} |",
        f"| Total Parent Overrides | {summary.get('totalOverrides', 0)} |",
        "",
    ]

    # Top 10 Hardest / Highest-Friction Trials
    def hardest_key(t: dict[str, Any]) -> tuple[Any, ...]:
        flag = t.get("flag")
        prio = 0 if flag in ("possible_bug", "too_hard") else 1
        comp = t.get("completionRate")
        med = t.get("medianAttemptsToSolve")
        t3 = t.get("tier3HintRate")
        ov = t.get("parentOverrides") or 0
        return (
            prio,
            comp if comp is not None else 101.0,
            -(med if med is not None else -1.0),
            -(t3 if t3 is not None else -1.0),
            -ov,
            t.get("trialId", ""),
        )

    hardest = sorted(with_data, key=hardest_key)[:10]
    lines.append("## Top 10 Hardest / Highest-Friction Trials")
    lines.append("")
    if not hardest:
        lines.append("_No trial attempts recorded in this window._")
    else:
        lines.append(
            "| Trial | Realm | Heroes | Completion | Median Att | Tier-3 Hints | Overrides | Flag |"
        )
        lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |")
        for t in hardest:
            lines.append(
                f"| `{_md_escape(t['trialId'])}` {_md_escape(t.get('title', ''))} "
                f"| `{_md_escape(t.get('realmId', ''))}` "
                f"| {t.get('uniqueHeroes', 0)} "
                f"| {_fmt_pct(t.get('completionRate'))} "
                f"| {_fmt_num(t.get('medianAttemptsToSolve'))} "
                f"| {_fmt_pct(t.get('tier3HintRate'))} "
                f"| {t.get('parentOverrides', 0)} "
                f"| `{t.get('flag', 'ok')}` |"
            )
    lines.append("")

    # Top 10 Easiest / Lowest-Challenge Trials
    def easiest_key(t: dict[str, Any]) -> tuple[Any, ...]:
        flag = t.get("flag")
        prio = 0 if flag == "too_easy" else 1
        ftp = t.get("firstTryPassRate")
        hint = t.get("hintUsageRate")
        return (
            prio,
            -(ftp if ftp is not None else -1.0),
            hint if hint is not None else 101.0,
            -(t.get("uniqueHeroes") or 0),
            t.get("trialId", ""),
        )

    easiest = sorted(
        [t for t in with_data if t.get("firstTryPassRate") is not None],
        key=easiest_key,
    )[:10]
    lines.append("## Top 10 Easiest / Lowest-Challenge Trials")
    lines.append("")
    if not easiest:
        lines.append("_No solved trial data recorded in this window._")
    else:
        lines.append("| Trial | Type | Heroes | First-Try Pass | Hint Usage | Median Att | Flag |")
        lines.append("| --- | --- | ---: | ---: | ---: | ---: | --- |")
        for t in easiest:
            lines.append(
                f"| `{_md_escape(t['trialId'])}` {_md_escape(t.get('title', ''))} "
                f"| `{_md_escape(t.get('trialType', 'code'))}` "
                f"| {t.get('uniqueHeroes', 0)} "
                f"| {_fmt_pct(t.get('firstTryPassRate'))} "
                f"| {_fmt_pct(t.get('hintUsageRate'))} "
                f"| {_fmt_num(t.get('medianAttemptsToSolve'))} "
                f"| `{t.get('flag', 'ok')}` |"
            )
    lines.append("")

    # Trials with Parent Overrides or Error Spikes
    alerts = [
        t
        for t in with_data
        if (t.get("parentOverrides") or 0) > 0
        or t.get("flag") == "possible_bug"
        or bool(t.get("topErrors"))
    ]
    alerts.sort(
        key=lambda t: (
            0 if t.get("flag") == "possible_bug" else 1,
            -(t.get("parentOverrides") or 0),
            -(t["topErrors"][0]["count"] if t.get("topErrors") else 0),
            t.get("trialId", ""),
        )
    )
    lines.append("## Trials with Parent Overrides or Error Spikes")
    lines.append("")
    if not alerts:
        lines.append("_No parent overrides or error spikes recorded in this window._")
    else:
        lines.append("| Trial | Overrides | Override Rate | Top Error | Flag | Reasons |")
        lines.append("| --- | ---: | ---: | --- | --- | --- |")
        for t in alerts[:15]:
            top_errs = t.get("topErrors") or []
            top_err_str = (
                f"`{_md_escape(top_errs[0]['errorType'])}` ({top_errs[0]['count']})"
                if top_errs
                else "—"
            )
            reasons = "; ".join(t.get("flagReasons") or []) or "—"
            lines.append(
                f"| `{_md_escape(t['trialId'])}` {_md_escape(t.get('title', ''))} "
                f"| {t.get('parentOverrides', 0)} "
                f"| {_fmt_pct(t.get('parentOverrideRate'))} "
                f"| {top_err_str} "
                f"| `{t.get('flag', 'ok')}` "
                f"| {_md_escape(reasons)} |"
            )
    lines.append("")

    # Before vs. After Calibration Comparison
    if compare_cutoff:
        lines.append(f"## Before vs. After Calibration (`{compare_cutoff}`)")
        lines.append("")
        if not compare_rows:
            lines.append(
                f"_No trials have attempts both before and on/after `{compare_cutoff}`._"
            )
        else:
            label = compare_rows[0].get("metricLabel", "Rate")
            lines.append(
                f"| Trial | Before Att | After Att | Before {label} | After {label} | Delta |"
            )
            lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
            for r in compare_rows[:15]:
                sign = "+" if r["delta"] > 0 else ""
                lines.append(
                    f"| `{_md_escape(r['trialId'])}` {_md_escape(r.get('title', ''))} "
                    f"| {r['beforeAttempts']} "
                    f"| {r['afterAttempts']} "
                    f"| {_fmt_pct(r['beforeRate'])} "
                    f"| {_fmt_pct(r['afterRate'])} "
                    f"| {sign}{r['delta']:.1f}pp |"
                )
        lines.append("")

    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate a periodic Pyria trial calibration report (Markdown or CSV)."
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--db",
        type=Path,
        default=None,
        help="Path to local Pyria SQLite database (default: data/pyria.sqlite3).",
    )
    source.add_argument(
        "--input",
        type=Path,
        default=None,
        help="Path to JSON file exported from GET /api/admin/trial-metrics.",
    )
    parser.add_argument(
        "--content-dir",
        type=Path,
        default=REPO_ROOT / "content",
        help="Path to content/ directory for trial metadata (default: content/).",
    )
    parser.add_argument(
        "--days",
        default="30",
        choices=sorted(VALID_DAYS_FILTERS),
        help="Rolling day window when reading --db (default: 30).",
    )
    parser.add_argument(
        "--since",
        default=None,
        help="Start date filter YYYY-MM-DD (UTC), overrides --days when reading --db.",
    )
    parser.add_argument(
        "--compare-cutoff",
        default=None,
        help="Cutoff date YYYY-MM-DD (UTC) for before-vs-after calibration comparison.",
    )
    parser.add_argument(
        "--difficulty",
        default="all",
        choices=sorted(VALID_DIFFICULTY_FILTERS),
        help="Difficulty mode filter when reading --db (default: all).",
    )
    parser.add_argument(
        "--min-heroes",
        type=int,
        default=5,
        help="Minimum unique heroes required before flagging outliers (default: 5).",
    )
    parser.add_argument(
        "--include-practice",
        action="store_true",
        help="Include practice replay attempts (is_practice=1).",
    )
    parser.add_argument(
        "--format",
        default="markdown",
        choices=["markdown", "csv"],
        help="Output format (default: markdown).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.since and not is_valid_iso_date(args.since):
        parser.error("--since must be a valid YYYY-MM-DD date")
    if args.compare_cutoff and not is_valid_iso_date(args.compare_cutoff):
        parser.error("--compare-cutoff must be a valid YYYY-MM-DD date")
    if args.min_heroes < 1 or args.min_heroes > 10000:
        parser.error("--min-heroes must be between 1 and 10000")

    compare_rows: list[dict[str, Any]] | None = None

    if args.input is not None:
        if not args.input.is_file():
            print(f"Error: input file not found: {args.input}", file=sys.stderr)
            return 2
        try:
            metrics = json.loads(args.input.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Error: failed to read JSON input: {exc}", file=sys.stderr)
            return 2
        if args.compare_cutoff:
            compare_rows = _compare_from_json_trends(
                metrics.get("trials") or [], args.compare_cutoff
            )
    else:
        db_path = args.db if args.db is not None else (REPO_ROOT / "data" / "pyria.sqlite3")
        if not db_path.is_file():
            print(f"Error: SQLite database not found: {db_path}", file=sys.stderr)
            return 2
        filters = {
            "eraId": None,
            "realmId": None,
            "trialType": None,
            "difficulty": args.difficulty,
            "days": args.days,
            "since": args.since,
            "minHeroes": args.min_heroes,
            "includePractice": bool(args.include_practice),
            "format": "csv" if args.format == "csv" else "json",
        }
        catalog = load_catalog_from_content_dir(args.content_dir)
        conn = sqlite3.connect(str(db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        try:
            metrics = compute_trial_metrics_from_conn(conn, catalog, filters)
            if args.compare_cutoff:
                compare_rows = _compare_from_sqlite(
                    conn, catalog, filters, args.compare_cutoff
                )
        finally:
            conn.close()

    if args.format == "csv":
        sys.stdout.write(format_trial_metrics_csv(metrics.get("trials") or []))
    else:
        sys.stdout.write(
            render_markdown_report(
                metrics,
                compare_cutoff=args.compare_cutoff,
                compare_rows=compare_rows,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
