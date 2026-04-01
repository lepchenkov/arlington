# Arlington Housing Pulse

Static GitHub Pages dashboard for Arlington County, Virginia residential sales.

## What it does

- Downloads Arlington County open data from the county `Property Sale History` and `Property` APIs with Python.
- Filters the raw feed down to market-like residential transactions with parcel coordinates.
- Publishes a static site that renders charts and a sales heatmap directly from generated JSON.
- Redeploys automatically on every push to `main` through GitHub Actions.

## Local usage

```bash
python3 scripts/build_site.py
python3 -m http.server 8000 -d dist
```

Then open `http://localhost:8000`.

## Deployment

The workflow at `.github/workflows/deploy-pages.yml` builds the site and deploys the `dist/` artifact to GitHub Pages whenever `main` changes.

In the repository settings, GitHub Pages should be configured to deploy from GitHub Actions.

## Data source

- Sales API: `https://datahub-v2.arlingtonva.us/api/RealEstate/SalesHistory`
- Property API: `https://datahub-v2.arlingtonva.us/api/RealEstate/Property`

## Notes

- The page is fully static. No backend is required after the JSON files are generated.
- The dashboard excludes vacant land, condo master or HOA parcels, non-market or administrative transfers, and records without active parcel coordinates.
