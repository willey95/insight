# API Setup (Secure)

This dashboard now reads sensitive API keys only from server environment variables.

## 1) Create environment file

```powershell
Copy-Item .env.example .env
```

Set:

- `ECOS_API_KEY` (Bank of Korea ECOS key)
- `FRED_API_KEY` (FRED key)
- `FASTFOREX_ACCOUNT` (FastForex account id)
- `FASTFOREX_API` (FastForex API token)
- `ALPHA_VANTAGE_API_KEY` (indices: KOSPI/KOSDAQ/NASDAQ/DOW/S&P500)
- `AISSTREAM_API_KEY` (optional, ship/air overlay future use)

## 2) Load env vars (PowerShell, current terminal)

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $name, $value = $_ -split '=', 2
  [System.Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim())
}
```

## 3) Run server

```powershell
node .\server.js
```

Open:

- `http://localhost:8787/`
- health check: `http://localhost:8787/api/health`

## Notes

- Never put keys in `crisis-monitoring-dashboard.html`.
- Browser-side key hiding is not secure (including WASM).
- If keys were exposed publicly, rotate them.
- `/api/indicators` priority: `FASTFOREX` for `USD/KRW`, fallback to FRED `DEXKOUS`.
- Stock indices are fetched from `ALPHA_VANTAGE`.
- `FASTFOREX_API_KEY` is still accepted as a legacy alias.
