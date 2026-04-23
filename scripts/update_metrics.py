import json
import sys
from pathlib import Path

SCHOLAR_ID = "YBNCZgoAAAAJ"
METRICS_FILE = Path(__file__).parent.parent / "data" / "metrics.json"

try:
    from scholarly import scholarly

    author = scholarly.search_author_id(SCHOLAR_ID)
    author = scholarly.fill(author, sections=["indices", "counts"])

    metrics = {
        "citations": author["citedby"],
        "h_index": author["hindex"],
        "i10_index": author["i10index"],
    }

    METRICS_FILE.write_text(json.dumps(metrics, indent=2) + "\n")
    print(f"Updated: {metrics}")

except Exception as e:
    print(f"Fetch failed ({e}), keeping existing metrics.json")
    sys.exit(0)
