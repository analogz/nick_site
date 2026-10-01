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
ROOT = Path(__file__).resolve().parents[1]
METRICS_FILE = ROOT / "data" / "metrics.json"
HTML_FILES = [ROOT / "index.html", ROOT / "publications.html", ROOT / "cv.html"]
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
PATENT_VENUE = re.compile(r"\bpatent\b", re.I)


def fetch_html(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        html = response.read().decode("utf-8", "ignore")
    if "unusual traffic" in html.lower() or "captcha" in html.lower():
        raise RuntimeError("Scholar challenged the request")
    return html


def count_works(html: str) -> tuple[int, int]:
    """Split profile rows into papers and patent documents.

    A patent document is any row whose venue contains "Patent", including
    applications. Scholar lists each granted patent and application separately,
    so this is a document count, not a count of unique inventions.
    """
    publications = patents = 0
    rows = re.findall(r'<tr class="gsc_a_tr">(.*?)</tr>', html, re.S)
    for row in rows:
        venues = re.findall(r'class="gs_gray"[^>]*>(.*?)</div>', row, re.S)
        venue = re.sub(r"<[^>]+>", "", venues[-1]) if venues else ""
        if PATENT_VENUE.search(venue):
            patents += 1
        else:
            publications += 1
    return publications, patents


def has_more_pages(html: str) -> bool:
    button = re.search(r'id="gsc_bpf_more"[^>]*>', html)
    return bool(button) and "disabled" not in button.group(0)


def scrape_scholar(scholar_id: str = SCHOLAR_ID) -> dict[str, int]:
    """Parse citation indices plus paper and patent counts from the profile."""
    last_error: Exception | None = None
    for hl in ("en", "de", "fr", "es"):
        try:
            html = fetch_html(
                f"https://scholar.google.com/citations?user={scholar_id}"
                f"&hl={hl}&cstart=0&pagesize=100"
            )
        except (urllib.error.URLError, TimeoutError, RuntimeError) as exc:
            last_error = exc
            continue

        # Sidebar table: Citations, h-index, i10-index × (all-time, since-year)
        values = re.findall(r'class="gsc_rsb_std">(\d[\d,]*)</td>', html)
        if len(values) < 6:
            last_error = RuntimeError(
                f"Scholar {hl} page missing citation table ({len(values)} cells)"
            )
            continue

        citations, h_index, i10_index = (int(values[i].replace(",", "")) for i in (0, 2, 4))
        publications, patents = count_works(html)
        start = 100
        try:
            while has_more_pages(html):
                html = fetch_html(
                    f"https://scholar.google.com/citations?user={scholar_id}"
                    f"&hl={hl}&cstart={start}&pagesize=100"
                )
                page_publications, page_patents = count_works(html)
                if page_publications + page_patents == 0:
                    raise RuntimeError(f"Scholar {hl} page at {start} had no rows")
                publications += page_publications
                patents += page_patents
                start += 100
                if start > 1000:
                    raise RuntimeError("Scholar pagination did not end")
        except (urllib.error.URLError, TimeoutError, RuntimeError) as exc:
            last_error = exc
            continue

        if min(citations, h_index, i10_index, publications, patents) <= 0:
            last_error = RuntimeError(f"Scholar {hl} returned non-positive metrics")
            continue

        return {
            "citations": citations,
            "h_index": h_index,
            "i10_index": i10_index,
            "publications": publications,
            "patents": patents,
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
    existing: dict = {}
    if METRICS_FILE.exists():
        try:
            existing = json.loads(METRICS_FILE.read_text())
        except json.JSONDecodeError:
            existing = {}

    payload = {
        "citations": metrics["citations"],
        "h_index": metrics["h_index"],
        "i10_index": metrics["i10_index"],
    }
    # The scholarly fallback has indices only. Keep the last paper and patent
    # counts rather than dropping them when the HTML scrape was blocked.
    for key in ("publications", "patents"):
        if key in metrics:
            payload[key] = metrics[key]
        elif key in existing:
            payload[key] = existing[key]

    METRICS_FILE.write_text(json.dumps(payload, indent=2) + "\n")
    if "publications" in payload and "patents" in payload:
        write_fallbacks(payload["publications"], payload["patents"])
    print(f"Updated via {source}: {payload}")
    return 0


def write_fallbacks(publications: int, patents: int) -> None:
    """Keep no-JS text and meta descriptions aligned with metrics.json."""
    for path in HTML_FILES:
        text = path.read_text()
        updated = re.sub(
            r'(id="metric-publications">)\d[\d,]*',
            rf"\g<1>{publications}",
            text,
        )
        updated = re.sub(
            r'(id="metric-patents">)\d[\d,]*\+?',
            rf"\g<1>{patents}",
            updated,
        )
        updated = re.sub(r"\d[\d,]*\+? patents", f"{patents} patents", updated)
        updated = re.sub(r"\d[\d,]* publications", f"{publications} publications", updated)
        if updated != text:
            path.write_text(updated)


if __name__ == "__main__":
    raise SystemExit(main())
