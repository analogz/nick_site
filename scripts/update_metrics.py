#!/usr/bin/env python3
"""Refresh data/metrics.json from Google Scholar.

Scholar actively blocks many automated clients (including the scholarly
library that the weekly Action used to call). A plain HTTPS fetch with a
browser User-Agent still returns the citation table reliably, so that is
the primary path. scholarly remains an optional fallback when installed.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

SCHOLAR_ID = "YBNCZgoAAAAJ"
METRICS_FILE = Path(__file__).resolve().parents[1] / "data" / "metrics.json"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def scrape_scholar(scholar_id: str = SCHOLAR_ID) -> dict[str, int]:
    """Parse the all-time citation / h / i10 cells from the profile sidebar."""
    last_error: Exception | None = None
    for hl in ("en", "de", "fr", "es"):
        url = f"https://scholar.google.com/citations?user={scholar_id}&hl={hl}"
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                html = response.read().decode("utf-8", "ignore")
        except (urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            continue

        if "unusual traffic" in html.lower() or "captcha" in html.lower():
            last_error = RuntimeError(f"Scholar challenged the {hl} request")
            continue

        # Sidebar table: Citations, h-index, i10-index × (all-time, since-year)
        values = re.findall(r'class="gsc_rsb_std">(\d[\d,]*)</td>', html)
        if len(values) < 6:
            last_error = RuntimeError(
                f"Scholar {hl} page missing citation table ({len(values)} cells)"
            )
            continue

        citations, h_index, i10_index = (int(values[i].replace(",", "")) for i in (0, 2, 4))
        if citations <= 0 or h_index <= 0 or i10_index <= 0:
            last_error = RuntimeError(f"Scholar {hl} returned non-positive metrics")
            continue

        return {
            "citations": citations,
            "h_index": h_index,
            "i10_index": i10_index,
            "source": f"scholar:{hl}",
        }

    raise RuntimeError(f"Scholar scrape failed ({last_error})")


def fetch_scholarly(scholar_id: str = SCHOLAR_ID) -> dict[str, int]:
    from scholarly import scholarly

    author = scholarly.search_author_id(scholar_id)
    author = scholarly.fill(author, sections=["indices", "counts"])
    return {
        "citations": int(author["citedby"]),
        "h_index": int(author["hindex"]),
        "i10_index": int(author["i10index"]),
        "source": "scholarly",
    }


def main() -> int:
    errors: list[str] = []
    metrics: dict[str, int] | None = None

    for fetcher in (scrape_scholar, fetch_scholarly):
        try:
            metrics = fetcher()
            break
        except Exception as exc:  # noqa: BLE001 - surface every backend failure
            errors.append(f"{fetcher.__name__}: {exc}")

    if metrics is None:
        print("Fetch failed; keeping existing metrics.json", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    source = metrics.pop("source")
    payload = {
        "citations": metrics["citations"],
        "h_index": metrics["h_index"],
        "i10_index": metrics["i10_index"],
    }
    METRICS_FILE.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Updated via {source}: {payload}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
