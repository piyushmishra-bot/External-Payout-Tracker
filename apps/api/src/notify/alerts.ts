/**
 * Team alerts: "a visitor sent a file for us to add". Each channel is on only when its settings are present:
 *   Slack  — ALERT_SLACK_WEBHOOK_URL (a Slack incoming webhook for the team channel)
 *   Email  — RESEND_API_KEY + ALERT_EMAIL_TO (comma-separated); ALERT_EMAIL_FROM optional
 *            (defaults to Resend's test sender, which only delivers to the Resend account's own address).
 * The file itself is never attached: the alert links to the admin page, where the team downloads it.
 * Alerts never block or fail the visitor's upload.
 */
export interface AssistedAlert {
  fileName: string;
  size: number;
  note?: string | null;
  who?: string | null;
  adminUrl: string;
}

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

export function alertText(a: AssistedAlert) {
  const lines = [
    `New file to add: ${a.fileName} (${kb(a.size)})`,
    `From: ${a.who || 'an anonymous visitor'}`,
    a.note ? `Note: ${a.note}` : '',
    'Add their holdings within 24 hours, then mark it as added.',
    `Open the admin page: ${a.adminUrl}`,
  ];
  return lines.filter(Boolean).join('\n');
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
  } finally {
    clearTimeout(t);
  }
}

/** Sends to every configured channel; returns which ones were sent (errors are logged, not thrown). */
export async function sendAssistedAlert(a: AssistedAlert, env: NodeJS.ProcessEnv = process.env, log: (msg: string) => void = console.warn) {
  const sent: string[] = [];
  const text = alertText(a);
  const jobs: Promise<void>[] = [];
  if (env.ALERT_SLACK_WEBHOOK_URL) {
    jobs.push(
      post(env.ALERT_SLACK_WEBHOOK_URL, { text }).then(
        () => void sent.push('slack'),
        (e) => log(`Slack alert failed: ${(e as Error).message}`),
      ),
    );
  }
  const to = (env.ALERT_EMAIL_TO ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.RESEND_API_KEY && to.length) {
    jobs.push(
      post(
        'https://api.resend.com/emails',
        {
          from: env.ALERT_EMAIL_FROM || 'BondScanner Holdings <onboarding@resend.dev>',
          to,
          subject: `New file to add: ${a.fileName}`,
          text,
        },
        { authorization: `Bearer ${env.RESEND_API_KEY}` },
      ).then(
        () => void sent.push('email'),
        (e) => log(`Email alert failed: ${(e as Error).message}`),
      ),
    );
  }
  await Promise.all(jobs);
  return sent;
}
