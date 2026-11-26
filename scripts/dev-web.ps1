# Local web page on http://localhost:5174/bond-portfolio (Windows PowerShell). Keep this window open while testing.
$env:Path = "$env:ProgramFiles\nodejs;$env:Path"
if (-not $env:VITE_DEV_USER_ID) { $env:VITE_DEV_USER_ID = 'demo-1' }  # local test user
Set-Location (Join-Path $PSScriptRoot '..')
npm run dev -w apps/web
