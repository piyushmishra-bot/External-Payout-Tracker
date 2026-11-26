# Local API on http://localhost:4020 (Windows PowerShell). Keep this window open while testing.
$env:Path = "$env:ProgramFiles\nodejs;$env:Path"
if (-not $env:EH_ADMIN_TOKEN) { $env:EH_ADMIN_TOKEN = '4PKrnXwg2tRspXYjEjvr06JP' }  # local dev only; needed for directory upload/sync
Set-Location (Join-Path $PSScriptRoot '..')
if (-not $env:PORT) { $env:PORT = '4020' }  # 4020 so it can run next to the External bonds holdings app (4010)
npm run dev:api
