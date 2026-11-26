import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { allEvents, planReminders, todayIST, withAutoReceived, type ISODate } from '@eh/core';
import type { Db } from '../db';
import type { HoldingsService } from '../services/holdings';
import type { BondService, CalendarService } from '../services/bonds';
import { senderFromEnv, type ChannelSender, type OutboxMessage } from './channels';

/**
 * Daily reminder planner. Run once a day after 00:30 IST (e.g. Kubernetes CronJob
 * "30 19 * * *" UTC). Safe to re-run: idempotency keys make inserts no-ops.
 */
export async function planDay(db: Db, holdings: HoldingsService, calendar: CalendarService, today: ISODate = todayIST()) {
  const users = await db.query<{ user_id: string }>(
    `SELECT DISTINCT p.user_id FROM eh_portfolios p JOIN eh_holdings h ON h.portfolio_id = p.id WHERE p.deleted_at IS NULL`,
  );
  const cal = await calendar.get();
  let planned = 0;
  for (const { user_id } of users) {
    try {
      const [{ items }, received, prefs] = await Promise.all([holdings.items(user_id), holdings.received(user_id), holdings.prefs(user_id)]);
      // Only payouts within the reminder horizon matter: 3 days back to 31 days ahead.
      const from = new Date(Date.parse(today) - 4 * 864e5).toISOString().slice(0, 10);
      const to = new Date(Date.parse(today) + 31 * 864e5).toISOString().slice(0, 10);
      const events = allEvents(items, cal, { from, to });
      for (const n of planReminders({ userId: user_id, events, prefs, today, received: withAutoReceived(items, today, received, cal) })) {
        const r = await db.query(
          `INSERT INTO eh_notification_outbox (id, user_id, idempotency_key, kind, channel, title, body, link, payload, send_after)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
          [randomUUID(), user_id, n.idempotencyKey, n.kind, n.channel, n.title, n.body, n.link, JSON.stringify({ eventKeys: n.eventKeys }), n.sendAfter],
        );
        planned += r.length;
      }
    } catch (e) {
      console.error(`[reminders] user ${user_id}: ${(e as Error).message}`);
    }
  }
  return { users: users.length, planned };
}

/**
 * Every 6 hours, after the Deridata → SNAPE sync: refresh terms for every ISIN users hold
 * (picks up date changes, calls, ratings), then release "Notify me" bonds that now have
 * data and tell their owners. Cron: minute 15 of hours 0, 6, 12, 18.
 */
export async function syncBonds(db: Db, bonds: BondService, askDetailsAfter = 4) {
  const held = await db.query<{ isin: string }>(
    `SELECT DISTINCT h.isin FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id
      WHERE p.deleted_at IS NULL`,
  );
  const refreshed = await bonds.refresh(held.map((r) => r.isin));
  const ready = await db.query<{ id: string; user_id: string; isin: string; name: string; portfolio: string }>(
    `SELECT h.id, p.user_id, h.isin, m.name, p.name AS portfolio
       FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id AND p.deleted_at IS NULL
       JOIN eh_bond_master m ON m.isin = h.isin
      WHERE h.awaiting OR (h.custom_terms IS NOT NULL AND h.notified_at IS NULL)`,
  );
  let notified = 0;
  for (const r of ready) {
    await db.tx(async (t) => {
      await t.query(`UPDATE eh_holdings SET awaiting=false, notified_at=now() WHERE id=$1`, [r.id]);
      const ins = await t.query(
        `INSERT INTO eh_notification_outbox (id, user_id, idempotency_key, kind, channel, title, body, link, payload, send_after)
         VALUES ($1,$2,$3,'bond_available','push',$4,$5,$6,$7, now()) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [
          randomUUID(),
          r.user_id,
          `${r.user_id}:bond_available:${r.id}`,
          `${r.name}: bond details updated`,
          `Exchange data is now available for ${r.isin} in ${r.portfolio}. Payouts have been updated and included in your totals.`,
          'bondscanner://holdings?tab=external',
          JSON.stringify({ holdingId: r.id, isin: r.isin }),
        ],
      );
      notified += ins.length;
    });
  }
  // Still no data: count the try; after enough tries, ask the user once for the details.
  await db.query(
    `UPDATE eh_holdings h SET lookup_attempts = lookup_attempts + 1
       FROM eh_portfolios p
      WHERE p.id = h.portfolio_id AND p.deleted_at IS NULL AND h.awaiting
        AND NOT EXISTS (SELECT 1 FROM eh_bond_master m WHERE m.isin = h.isin)`,
  );
  const ask = await db.query<{ id: string; user_id: string; isin: string; units: string; portfolio: string }>(
    `SELECT h.id, p.user_id, h.isin, h.units, p.name AS portfolio
       FROM eh_holdings h JOIN eh_portfolios p ON p.id = h.portfolio_id AND p.deleted_at IS NULL
      WHERE h.awaiting AND h.details_requested_at IS NULL AND h.invested_amount IS NULL AND h.lookup_attempts >= $1`,
    [askDetailsAfter],
  );
  let asked = 0;
  for (const r of ask) {
    await db.tx(async (t) => {
      await t.query(`UPDATE eh_holdings SET details_requested_at=now() WHERE id=$1`, [r.id]);
      const ins = await t.query(
        `INSERT INTO eh_notification_outbox (id, user_id, idempotency_key, kind, channel, title, body, link, payload, send_after)
         VALUES ($1,$2,$3,'details_needed','push',$4,$5,$6,$7, now()) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [
          randomUUID(),
          r.user_id,
          `${r.user_id}:details_needed:${r.id}`,
          `Complete your investment details for ${r.isin}`,
          `This bond in ${r.portfolio} is not yet in our records. Add the date of investment, units, invested amount and yield so your holding is complete.`,
          `bondscanner://holdings?tab=external&details=${r.id}`,
          JSON.stringify({ holdingId: r.id, isin: r.isin }),
        ],
      );
      asked += ins.length;
    });
  }
  return { isins: held.length, refreshed: refreshed.length, released: ready.length, notified, asked };
}

/** Drain due messages. Run every few minutes. Uses SKIP LOCKED so several workers can run. */
export async function drainOutbox(db: Db, sender: ChannelSender, batch = 200) {
  const due = await db.tx(async (t) => {
    const rows = await t.query<OutboxMessage & { user_id: string }>(
      `SELECT id, user_id AS "userId", kind, channel, title, body, link, payload
         FROM eh_notification_outbox
        WHERE status='pending' AND send_after <= now() AND attempts < 5
        ORDER BY send_after LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    if (rows.length) await t.query(`UPDATE eh_notification_outbox SET attempts = attempts + 1 WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    return rows;
  });
  let sent = 0;
  for (const m of due) {
    try {
      await sender.send(m);
      await db.query(`UPDATE eh_notification_outbox SET status='sent', sent_at=now() WHERE id=$1`, [m.id]);
      sent++;
    } catch (e) {
      await db.query(
        `UPDATE eh_notification_outbox SET last_error=$2, status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END WHERE id=$1`,
        [m.id, (e as Error).message.slice(0, 500)],
      );
    }
  }
  return { due: due.length, sent };
}

// CLI: `npm run worker -- sync|plan|drain|both [YYYY-MM-DD]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { buildContainer } = await import('../container');
  const { config } = await import('../config');
  const c = await buildContainer();
  const mode = process.argv[2] ?? 'both';
  if (mode === 'sync') console.log('[sync]', await syncBonds(c.db, c.bonds, config.askDetailsAfterSyncs));
  const today = process.argv[3];
  if (mode === 'plan' || mode === 'both') console.log('[reminders] planned', await planDay(c.db, c.holdings, c.calendar, today));
  if (mode === 'drain' || mode === 'both') console.log('[reminders] drained', await drainOutbox(c.db, senderFromEnv()));
  await c.db.close();
}
