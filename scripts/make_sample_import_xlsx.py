from __future__ import annotations

from pathlib import Path

import pandas as pd


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    csv_path = repo_root / "scripts" / "sample_product_import.csv"
    out_path = repo_root / "scripts" / "sample_product_import.xlsx"

    df = pd.read_csv(csv_path)
    with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Sheet1")

    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()

