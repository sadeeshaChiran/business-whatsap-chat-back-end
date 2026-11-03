/**
 * WhatsApp Cloud API error codes → what the shop owner should know and do (shown under "Why N failed").
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const KNOWN: Array<{ codes: number[]; text: string; fix: string }> = [
  { codes: [131058], text: '“hello_world” is Meta\'s sample template – it only works from Meta\'s test number.',
    fix: 'Create your own template in Marketing → Message templates (approved in minutes), then send the broadcast with it.' },
  { codes: [132001], text: 'The template does not exist in this language (or was deleted).', fix: 'Pick the template again in a new broadcast.' },
  { codes: [132000], text: 'The template needs a different number of values ({{1}}, {{2}} …).', fix: 'Fill every value of the template.' },
  { codes: [132005, 132007], text: 'The text with your values is too long or breaks the template rules.', fix: 'Use shorter values.' },
  { codes: [132015, 132016], text: 'The template was paused or disabled by Meta (low quality).', fix: 'Use another template or create a new one.' },
  { codes: [131026], text: 'This number cannot receive the message (not on WhatsApp, old app, or has not accepted the terms).', fix: 'Check the number with the customer.' },
  { codes: [131049], text: 'Meta did not deliver it to keep a healthy experience – this person got many marketing messages recently.', fix: 'Try again in a few days; send fewer marketing messages to the same people.' },
  { codes: [131050], text: 'The customer stopped marketing messages from your business on WhatsApp.', fix: 'Do not send marketing to this number.' },
  { codes: [131047], text: 'More than 24 hours since the customer\'s last message – only templates can be sent.', fix: 'Send a template instead.' },
  { codes: [131056], text: 'Too many messages to the same number in a short time.', fix: 'Wait a little and try again.' },
  { codes: [130429, 131048], text: 'Sending too fast or too many failed messages – Meta slowed your number down.', fix: 'Send smaller groups and only to customers who know your business.' },
  { codes: [131031], text: 'Your WhatsApp Business account is locked or restricted by Meta.', fix: 'Check WhatsApp Manager → Account quality.' },
  { codes: [131042], text: 'Payment problem on your WhatsApp Business account.', fix: 'Add or fix the payment method in WhatsApp Manager → Billing.' },
  { codes: [133010], text: 'Your WhatsApp number is not registered with the Cloud API.', fix: 'Open Channels → WhatsApp and press “Fix it”.' },
  { codes: [190, 10], text: 'The WhatsApp access token expired or lost its permissions.', fix: 'Reconnect WhatsApp in Channels → WhatsApp.' },
  { codes: [100], text: 'Meta refused the request (wrong number format or template data).', fix: 'Check the phone number and template values.' },
];

export function explainWhatsAppError(raw: string | null | undefined): { text: string; fix: string | null; code: number | null } {
  const message = String(raw ?? '').trim();
  const code = Number(/#(\d{2,6})/.exec(message)?.[1] ?? /\b(1[3]\d{4})\b/.exec(message)?.[1] ?? NaN);
  const known = Number.isFinite(code) ? KNOWN.find((k) => k.codes.includes(code)) : undefined;
  if (known) return { text: known.text, fix: known.fix, code };
  if (!message || message === 'failed') return { text: 'Meta did not deliver this message.', fix: 'Check that the number uses WhatsApp and has talked to you before.', code: null };
  return { text: message.replace(/^Meta:\s*/, ''), fix: null, code: Number.isFinite(code) ? code : null };
}

/** Meta's own sample templates that only work from the test number. */
export const SAMPLE_TEMPLATES = new Set(['hello_world']);
