import { addDays } from './dates';
import { formatDate, inr } from './format';
import { round2 } from './schedule';
import type { ISODate, NotificationPrefs, PayoutEvent } from './types';

export type ReminderKind = 'payout_tomorrow' | 'payout_today' | 'confirm_received' | 'maturity_30d';
export type Channel = 'push' | 'email' | 'whatsapp';

export interface PlannedNotification {
  userId: string;
  kind: ReminderKind;
  channel: Channel;
  /** Unique per user, kind, date and channel, so a re-run of the job never double-sends. */
  idempotencyKey: string;
  /** When to send, as an ISO timestamp. 09:00 IST on the target day. */
  sendAfter: string;
  title: string;
  body: string;
  /** Deep link into the app. */
  link: string;
  eventKeys: string[];
}

/** 09:00 IST = 03:30 UTC. */
export const SEND_HOUR_UTC = '03:30:00.000Z';

const sumAmt = (es: PayoutEvent[]) => round2(es.reduce((s, e) => s + e.amount, 0));

function payoutCopy(kind: 'payout_tomorrow' | 'payout_today', es: PayoutEvent[]) {
  const when = kind === 'payout_tomorrow' ? 'tomorrow' : 'today';
  if (es.length === 1) {
    const e = es[0];
    const what = e.principal > 0 && e.interest > 0 ? 'interest and principal' : e.principal > 0 ? 'principal' : 'interest';
    return {
      title: `${inr(e.amount)} payout ${when}`,
      body: `${e.bondName} pays ${what} of ${inr(e.amount)} ${when}, ${formatDate(e.date)}. Amounts are before tax.`,
    };
  }
  return {
    title: `${es.length} payouts ${when} · ${inr(sumAmt(es))}`,
    body: `${es.length} of your bonds pay out ${when}, ${formatDate(es[0].date)}, totalling ${inr(sumAmt(es))} before tax.`,
  };
}

/**
 * Plan the notifications one user should get on `today` (IST). Pure: the worker
 * persists the result to an outbox with the idempotency key as a unique index.
 */
export function planReminders(args: {
  userId: string;
  events: PayoutEvent[];
  prefs: NotificationPrefs;
  today: ISODate;
  received: ReadonlySet<string>;
}): PlannedNotification[] {
  const { userId, events, prefs, today, received } = args;
  const channels: Channel[] = (['push', 'email', 'whatsapp'] as Channel[]).filter((c) => prefs[c]);
  if (!channels.length) return [];
  const open = events.filter((e) => !received.has(e.key));
  const groups: { kind: ReminderKind; date: ISODate; es: PayoutEvent[]; title: string; body: string; link: string }[] = [];

  const tomorrow = addDays(today, 1);
  const dueTomorrow = open.filter((e) => e.date === tomorrow);
  if (prefs.dayBefore && dueTomorrow.length)
    groups.push({ kind: 'payout_tomorrow', date: tomorrow, es: dueTomorrow, ...payoutCopy('payout_tomorrow', dueTomorrow), link: `bondscanner://external-holdings/payouts?date=${tomorrow}` });

  const dueToday = open.filter((e) => e.date === today);
  if (prefs.sameDay && dueToday.length)
    groups.push({ kind: 'payout_today', date: today, es: dueToday, ...payoutCopy('payout_today', dueToday), link: `bondscanner://external-holdings/payouts?date=${today}` });

  const nudgeDate = addDays(today, -3);
  const unconfirmed = open.filter((e) => e.date === nudgeDate);
  if (prefs.confirmNudge && unconfirmed.length)
    groups.push({
      kind: 'confirm_received',
      date: nudgeDate,
      es: unconfirmed,
      title: 'Did your payout arrive?',
      body: `${unconfirmed.length === 1 ? unconfirmed[0].bondName + ' was due to pay ' + inr(unconfirmed[0].amount) : unconfirmed.length + ' payouts were due'} on ${formatDate(nudgeDate)}. Mark it received to keep your records straight.`,
      link: `bondscanner://external-holdings/payouts?date=${nudgeDate}`,
    });

  const maturing = events.filter((e) => e.isFinal && e.date === addDays(today, 30));
  if (prefs.maturityHeadsUp && maturing.length)
    groups.push({
      kind: 'maturity_30d',
      date: maturing[0].date,
      es: maturing,
      title: `${inr(sumAmt(maturing))} comes back to you in 30 days`,
      body: `${maturing.map((e) => e.bondName).join(', ')} ${maturing.length === 1 ? 'matures' : 'mature'} on ${formatDate(maturing[0].date)}. Explore bonds on BondScanner to plan what is next.`,
      link: `bondscanner://bonds?tab=explore&utm_source=eh_maturity`,
    });

  return groups.flatMap((g) =>
    channels.map((channel) => ({
      userId,
      kind: g.kind,
      channel,
      idempotencyKey: `${userId}:${g.kind}:${g.date}:${channel}`,
      sendAfter: `${today}T${SEND_HOUR_UTC}`,
      title: g.title,
      body: g.body,
      link: g.link,
      eventKeys: g.es.map((e) => e.key),
    })),
  );
}
