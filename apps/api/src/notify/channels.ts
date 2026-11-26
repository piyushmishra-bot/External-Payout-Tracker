/**
 * Delivery channels. Each is an adapter around a vendor; plug in the ones
 * BondScanner already uses (e.g. FCM / CleverTap / MoEngage for push,
 * SES / SendGrid for email, Gupshup / Interakt / MSG91 for WhatsApp).
 * Until configured, the log channel records what would have been sent.
 */
export interface OutboxMessage {
  id: string;
  userId: string;
  kind: string;
  channel: 'push' | 'email' | 'whatsapp';
  title: string;
  body: string;
  link: string | null;
  payload: Record<string, unknown>;
}

export interface ChannelSender {
  send(m: OutboxMessage): Promise<void>;
}

export class LogSender implements ChannelSender {
  readonly sent: OutboxMessage[] = [];
  async send(m: OutboxMessage) {
    this.sent.push(m);
    console.log(`[notify:${m.channel}] → ${m.userId}: ${m.title} — ${m.body}`);
  }
}

/**
 * Generic HTTP webhook sender: POSTs the message to your existing notification
 * service, which already knows the user's device tokens, email and WhatsApp opt-in.
 * This is usually the simplest integration: BondScanner's notification service
 * owns delivery, this feature only decides what and when.
 */
export class WebhookSender implements ChannelSender {
  constructor(private readonly url: string, private readonly token?: string) {}
  async send(m: OutboxMessage) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({
        userId: m.userId,
        channel: m.channel,
        template: `external_holdings.${m.kind}`,
        title: m.title,
        body: m.body,
        deepLink: m.link,
        data: m.payload,
        idempotencyKey: m.id,
      }),
    });
    if (!res.ok) throw new Error(`Notification service returned ${res.status}`);
  }
}

export function senderFromEnv(): ChannelSender {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  return url ? new WebhookSender(url, process.env.NOTIFY_WEBHOOK_TOKEN) : new LogSender();
}
