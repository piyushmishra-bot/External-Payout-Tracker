# Adds a free Neon Postgres database to the linked Vercel team and connects it to this project.
# Interactive: answer Vercel's questions (plan Free, region Mumbai/Singapore, accept Neon's terms, connect to external-payout).
$env:Path = "$env:ProgramFiles\nodejs;$env:Path"
npx --yes vercel@latest integration add neon
