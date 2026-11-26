# Rollout plan

| Phase | When | What | Exit criteria |
|---|---|---|---|
| 0. Access | Week 1 | Get items 1–10 in `DATA_ACCESS.md`. Run Superset discovery + coverage SQL. | SNAPE mapping done; coverage ≥ 95% of ISINs BondScanner users hold |
| 1. Wire-up | Week 1–2 | Fill provider mappings, internal holdings provider, gateway auth, notification webhook. PR + code review. | CI green; staging deploy |
| 2. Parser tuning | Week 2 | Run 15–20 real anonymised statements through staging; fix heuristics; add them as test fixtures. | ≥ 85% rows matched without edits on PDF/Excel |
| 3. Internal dogfood | Week 3 | `EH_ROLLOUT_USERS` = team. Daily reminder job on. | No wrong payout dates reported for 1 week |
| 4. Beta | Week 4 | 5% of active investors (add their ids or switch flag to a % rollout in the gateway). | Import success ≥ 70%; reminder delivery ≥ 98% |
| 5. GA | Week 5–6 | Everyone; launch comms (email + in-app card). | Metrics in PRD |

## Launch checklist
- [ ] Compliance sign-off on consent copy, notification copy, disclaimers
- [ ] 2027 holiday list loaded (NSE circular mid-December)
- [ ] Notification templates approved (push, email, WhatsApp opt-in)
- [ ] Superset dashboard live (`04_adoption_dashboard.sql`)
- [ ] Alert on `eh_notification_outbox` failed > 1% / day
- [ ] Support macro: "My payout date looks wrong" → check record date, holiday shift, user-entered terms
- [ ] Data deletion path tested (delete portfolio removes holdings + receipts)
