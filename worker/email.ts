import type { Env, SendEmailBinding } from './types';

export const DEFAULT_EMAIL_API_URL = 'https://api.resend.com/emails';
export const DEFAULT_EMAIL_FROM = 'Pyria <updates@pyria.dev>';

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  providerMessageId: string | null;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function extractAddress(fromOrTo: string): string {
  const match = fromOrTo.match(/<([^>]+)>/);
  return (match ? match[1] : fromOrTo).trim();
}

/**
 * Build a minimal RFC 5322 multipart/alternative MIME message suitable for
 * Cloudflare Email Sending (`SEND_EMAIL` binding).
 */
export function buildRawMimeMessage(message: EmailMessage): string {
  const boundary = `pyria-digest-${crypto.randomUUID().replace(/-/g, '')}`;
  const lines: string[] = [
    `From: ${sanitizeHeaderValue(message.from)}`,
    `To: ${sanitizeHeaderValue(message.to)}`,
    `Subject: ${sanitizeHeaderValue(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@pyria.dev>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  if (message.headers) {
    for (const [key, val] of Object.entries(message.headers)) {
      const cleanKey = sanitizeHeaderValue(key);
      const cleanVal = sanitizeHeaderValue(val);
      if (cleanKey && cleanVal) {
        lines.push(`${cleanKey}: ${cleanVal}`);
      }
    }
  }

  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset="utf-8"');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(message.text.replace(/\r?\n/g, '\r\n'));
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/html; charset="utf-8"');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(message.html.replace(/\r?\n/g, '\r\n'));
  lines.push('');
  lines.push(`--${boundary}--`);
  lines.push('');

  return lines.join('\r\n');
}

/**
 * HTTP transactional email transport (Resend-compatible JSON API).
 * Configured via Worker secret `EMAIL_API_KEY` and optional `EMAIL_API_URL`.
 */
export class HttpApiEmailSender implements EmailSender {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, apiUrl = DEFAULT_EMAIL_API_URL, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.fetchImpl = fetchImpl;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const res = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers ?? {},
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Email HTTP API failed (${res.status}): ${detail.slice(0, 200) || res.statusText}`
      );
    }

    let providerMessageId: string | null = null;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.id === 'string' && body.id.trim()) {
        providerMessageId = body.id.trim();
      } else if (typeof body.messageId === 'string' && body.messageId.trim()) {
        providerMessageId = body.messageId.trim();
      }
    } catch {
      // Non-JSON 2xx response is still considered accepted
    }

    return { providerMessageId };
  }
}

/**
 * Cloudflare Email Sending binding (`SEND_EMAIL`) transport.
 */
export class CloudflareEmailBindingSender implements EmailSender {
  private readonly binding: SendEmailBinding;

  constructor(binding: SendEmailBinding) {
    this.binding = binding;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const raw = buildRawMimeMessage(message);
    await this.binding.send({
      from: extractAddress(message.from),
      to: extractAddress(message.to),
      raw,
    });
    return { providerMessageId: null };
  }
}

export function getEmailFrom(env: Env): string {
  const configured = (env.EMAIL_FROM || '').trim();
  return configured || DEFAULT_EMAIL_FROM;
}

export function createEmailSender(env: Env, fetchImpl?: typeof fetch): EmailSender | null {
  const apiKey = (env.EMAIL_API_KEY || '').trim();
  if (apiKey) {
    const apiUrl = (env.EMAIL_API_URL || '').trim() || DEFAULT_EMAIL_API_URL;
    return new HttpApiEmailSender(apiKey, apiUrl, fetchImpl ?? fetch);
  }
  if (env.SEND_EMAIL && typeof env.SEND_EMAIL.send === 'function') {
    return new CloudflareEmailBindingSender(env.SEND_EMAIL);
  }
  return null;
}
