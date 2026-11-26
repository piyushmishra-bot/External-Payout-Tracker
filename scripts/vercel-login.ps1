# Signs this computer in to Vercel (opens the browser). Run once before deploying.
$env:Path = "$env:ProgramFiles\nodejs;$env:Path"
npx --yes vercel@latest login
