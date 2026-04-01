#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any
from urllib import parse, request

ROOT = Path(__file__).resolve().parents[1]
SITE_DIR = ROOT / "web"
DIST_DIR = ROOT / "dist"
DATA_DIR = DIST_DIR / "data"

SALES_API = "https://datahub-v2.arlingtonva.us/api/RealEstate/SalesHistory"
PROPERTY_API = "https://datahub-v2.arlingtonva.us/api/RealEstate/Property"
PAGE_SIZE = 10_000

SINGLE_FAMILY_CODES = {
    "511",
    "518",
    "519",
    "520",
    "521",
    "528",
    "529",
    "530",
    "531",
    "541",
    "543",
}
TOWNHOUSE_CODES = {"512", "513", "514"}
DUPLEX_CODES = {"515"}
CONDO_CODES = {"611", "612", "613", "614", "616", "617", "641", "642"}
ALLOWED_PROPERTY_CODES = (
    SINGLE_FAMILY_CODES | TOWNHOUSE_CODES | DUPLEX_CODES | CONDO_CODES
)
MARKET_SALE_CODES = {None, "", "1", "G", "R"}


def iso_date(value: dt.date) -> str:
    return value.isoformat()


def years_ago(today: dt.date, years: int) -> dt.date:
    try:
        return today.replace(year=today.year - years)
    except ValueError:
        return today.replace(month=2, day=28, year=today.year - years)


def fetch_json(url: str, retries: int = 3) -> list[dict[str, Any]]:
    last_error: Exception | None = None
    headers = {"User-Agent": "arlington-pages-dashboard/1.0"}

    for attempt in range(1, retries + 1):
        try:
            with request.urlopen(request.Request(url, headers=headers), timeout=90) as response:
                return json.load(response)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt == retries:
                break
            time.sleep(attempt * 2)

    raise RuntimeError(f"Failed to fetch {url}") from last_error


def fetch_all(base_url: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    skip = 0

    while True:
        page_params = {**params, "$top": PAGE_SIZE, "$skip": skip}
        url = f"{base_url}?{parse.urlencode(page_params)}"
        page = fetch_json(url)
        rows.extend(page)
        print(f"Fetched {len(page):>5} rows from skip={skip}", file=sys.stderr)
        if len(page) < PAGE_SIZE:
            break
        skip += PAGE_SIZE

    return rows


def classify_property(code: str | None) -> str | None:
    if code in SINGLE_FAMILY_CODES:
        return "Single-family"
    if code in TOWNHOUSE_CODES:
        return "Townhouse"
    if code in DUPLEX_CODES:
        return "Duplex"
    if code in CONDO_CODES:
        return "Condo / co-op"
    return None


def is_market_sale(sale_code: str | None) -> bool:
    return sale_code in MARKET_SALE_CODES


def parse_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    return float(value)


def parse_date(value: str | None) -> str | None:
    if not value:
        return None
    return value[:10]


def fetch_properties() -> dict[int, dict[str, Any]]:
    params = {
        "$select": (
            "propertyKey,realEstatePropertyCode,propertyClassTypeCode,propertyClassTypeDsc,"
            "latitudeCrd,longitudeCrd,neighborhoodNbr,propertyStreetNbrNameText,"
            "propertyZipCode,propertyYearBuilt,reasPropertyStatusCode"
        ),
        "$filter": "reasPropertyStatusCode eq 'A'",
        "$orderby": "propertyKey asc",
    }
    rows = fetch_all(PROPERTY_API, params)
    properties: dict[int, dict[str, Any]] = {}

    for row in rows:
        property_key = row.get("propertyKey")
        if property_key is None:
            continue

        class_code = row.get("propertyClassTypeCode")
        category = classify_property(class_code)
        if category is None:
            continue

        lat = parse_float(row.get("latitudeCrd"))
        lon = parse_float(row.get("longitudeCrd"))
        if lat is None or lon is None:
            continue

        properties[int(property_key)] = {
            "address": row.get("propertyStreetNbrNameText"),
            "classCode": class_code,
            "classDescription": row.get("propertyClassTypeDsc"),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "neighborhood": row.get("neighborhoodNbr"),
            "propertyType": category,
            "yearBuilt": row.get("propertyYearBuilt"),
            "zipCode": row.get("propertyZipCode"),
        }

    return properties


def fetch_sales(start_date: dt.date) -> list[dict[str, Any]]:
    params = {
        "$select": (
            "salesHistoryKey,propertyKey,realEstatePropertyCode,salesTypeCode,"
            "salesTypeDsc,saleAmt,saleDate"
        ),
        "$filter": f"saleDate ge {start_date.isoformat()}T00:00:00.000Z and saleAmt gt 0",
        "$orderby": "salesHistoryKey asc",
    }
    return fetch_all(SALES_API, params)


def build_records(
    sales_rows: list[dict[str, Any]],
    properties: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    for row in sales_rows:
        property_key = row.get("propertyKey")
        if property_key is None:
            continue

        if not is_market_sale(row.get("salesTypeCode")):
            continue

        property_info = properties.get(int(property_key))
        if property_info is None:
            continue

        sale_date = parse_date(row.get("saleDate"))
        if sale_date is None:
            continue

        sale_amount = row.get("saleAmt")
        if sale_amount in (None, 0):
            continue

        records.append(
            {
                "address": property_info["address"],
                "lat": property_info["lat"],
                "lon": property_info["lon"],
                "propertyType": property_info["propertyType"],
                "saleAmount": int(sale_amount),
                "saleDate": sale_date,
                "zipCode": property_info["zipCode"],
            }
        )

    records.sort(key=lambda item: (item["saleDate"], item["saleAmount"]), reverse=True)
    return records


def build_payload(
    records: list[dict[str, Any]],
    start_date: dt.date,
    raw_sales_count: int,
    property_count: int,
) -> dict[str, Any]:
    property_types = sorted({record["propertyType"] for record in records})
    last_sale_date = max(record["saleDate"] for record in records) if records else None

    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "window": {
            "startDate": iso_date(start_date),
            "endDate": last_sale_date,
        },
        "build": {
            "rawSalesRows": raw_sales_count,
            "matchedResidentialProperties": property_count,
            "publishedTransactions": len(records),
        },
        "propertyTypes": property_types,
        "source": {
            "salesApi": SALES_API,
            "propertyApi": PROPERTY_API,
        },
        "notes": [
            "Built from Arlington County's Property Sale History and Property APIs.",
            "Includes residential single-family, townhouse, duplex, and condo/co-op parcels.",
            "Excludes non-market and administrative transfers, vacant land, condo master or HOA parcels, and records without active parcel coordinates.",
            "Market-like transfers include uncoded sales plus new construction, foreclosure, and relocation-sale records.",
        ],
        "records": records,
    }


def prepare_dist() -> None:
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    shutil.copytree(SITE_DIR, DIST_DIR)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DIST_DIR / ".nojekyll").write_text("", encoding="utf-8")


def write_payload(payload: dict[str, Any]) -> None:
    output_path = DATA_DIR / "transactions.json"
    output_path.write_text(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=True),
        encoding="utf-8",
    )
    print(f"Wrote {output_path.relative_to(ROOT)}", file=sys.stderr)


def main() -> None:
    today = dt.date.today()
    start_date = years_ago(today, 10)
    print(f"Building Arlington dashboard from {start_date.isoformat()} onward", file=sys.stderr)

    prepare_dist()
    properties = fetch_properties()
    sales_rows = fetch_sales(start_date)
    records = build_records(sales_rows, properties)
    payload = build_payload(records, start_date, len(sales_rows), len(properties))
    write_payload(payload)

    print(
        json.dumps(
            {
                "publishedTransactions": payload["build"]["publishedTransactions"],
                "rawSalesRows": payload["build"]["rawSalesRows"],
                "matchedResidentialProperties": payload["build"]["matchedResidentialProperties"],
                "latestSaleDate": payload["window"]["endDate"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
