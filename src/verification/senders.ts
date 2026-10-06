import { BrandingService } from '../platform/branding.service';
import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

const logger = new Logger('Verification');
const env = (name: string) => String(process.env[name] ?? '').trim();

/** true = codes are also written to the server log (only for local testing – never in production) */
export const otpDevMode = () => env('OTP_DEV_MODE') === 'true' && env('NODE_ENV') !== 'production';

/**
 * Email over SMTP (Gmail, Zoho, cPanel, SES SMTP, Resend SMTP …).
 * SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (false for 587, true for 465), SMTP_USER, SMTP_PASS, SMTP_FROM ("Agent Metra <no-reply@…>")
 */
export async function sendEmail(to: string, subject: string, text: string, html: string): Promise<boolean> {
  if (!env('SMTP_HOST')) {
    if (otpDevMode()) { logger.warn(`[dev] email to ${to}: ${text}`); return true; }
    logger.error('SMTP_HOST is not set – verification emails cannot be sent.');
    return false;
  }
  try {
    const transport = nodemailer.createTransport({
      host: env('SMTP_HOST'), port: Number(env('SMTP_PORT') || 587), secure: env('SMTP_SECURE') === 'true',
      auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined,
    });
    await transport.sendMail({ from: env('SMTP_FROM') || env('SMTP_USER'), to, subject, text, html });
    return true;
  } catch (error) {
    logger.error(`sending email to ${to} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * WhatsApp code from Metrocoding's own WhatsApp Cloud API number, with an approved AUTHENTICATION template
 * (body {{1}} = code, "Copy code" button). OTP_WHATSAPP_PHONE_NUMBER_ID, OTP_WHATSAPP_TOKEN,
 * OTP_WHATSAPP_TEMPLATE (default "verification_code"), OTP_WHATSAPP_LANG (default "en_US").
 */
export async function sendWhatsappCode(phone: string, code: string): Promise<boolean> {
  const phoneNumberId = env('OTP_WHATSAPP_PHONE_NUMBER_ID');
  const token = env('OTP_WHATSAPP_TOKEN');
  if (!phoneNumberId || !token) return false;
  try {
    const version = env('META_GRAPH_API_VERSION') || 'v22.0';
    const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: phone, type: 'template',
        template: {
          name: env('OTP_WHATSAPP_TEMPLATE') || 'verification_code',
          language: { code: env('OTP_WHATSAPP_LANG') || 'en_US' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) logger.warn(`WhatsApp code to ${phone} failed: ${(await response.text()).slice(0, 300)}`);
    return response.ok;
  } catch (error) {
    logger.warn(`WhatsApp code to ${phone} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Optional SMS fallback (Notify.lk): NOTIFYLK_USER_ID, NOTIFYLK_API_KEY, NOTIFYLK_SENDER_ID */
export async function sendSmsCode(phone: string, code: string): Promise<boolean> {
  if (!env('NOTIFYLK_USER_ID') || !env('NOTIFYLK_API_KEY')) return false;
  try {
    const params = new URLSearchParams({
      user_id: env('NOTIFYLK_USER_ID'), api_key: env('NOTIFYLK_API_KEY'), sender_id: env('NOTIFYLK_SENDER_ID') || 'NotifyDEMO',
      to: phone, message: `Your ${BrandingService.current().name} code is ${code}. It is valid for 10 minutes.`,
    });
    const response = await fetch(`https://app.notify.lk/api/v1/send?${params.toString()}`, { signal: AbortSignal.timeout(15000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** WhatsApp first, SMS if WhatsApp is not set up or fails. Dev mode logs the code. */
export async function sendPhoneCode(phone: string, code: string): Promise<'whatsapp' | 'sms' | 'dev' | null> {
  if (await sendWhatsappCode(phone, code)) return 'whatsapp';
  if (await sendSmsCode(phone, code)) return 'sms';
  if (otpDevMode()) { logger.warn(`[dev] WhatsApp code for ${phone}: ${code}`); return 'dev'; }
  return null;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function codeEmail(code: string, intro: string) {
  const brand = BrandingService.current();
  const name = escapeHtml(brand.name);
  const byLine = escapeHtml(brand.by_line);
  const color = /^#[0-9a-f]{6}$/i.test(brand.primary_color) ? brand.primary_color : '#4f46e5';
  const contact = [brand.support_email, brand.support_phone, brand.website].filter(Boolean).map(escapeHtml).join(' · ');
  const text = `${intro}\n\nYour code: ${code}\n\nIt is valid for 10 minutes. If you did not ask for this, ignore this email.\n\n${brand.name} ${brand.by_line}`.trim();
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0f172a">
    <p style="font-size:20px;font-weight:800;margin:0">${name}</p>${byLine ? `<p style="color:${color};font-size:11px;letter-spacing:2px;margin:0 0 24px;text-transform:uppercase">${byLine}</p>` : '<div style="height:24px"></div>'}
    <p>${escapeHtml(intro)}</p>
    <p style="font-size:32px;font-weight:800;letter-spacing:8px;background:${color}14;border-radius:12px;padding:16px;text-align:center">${code}</p>
    <p style="color:#64748b;font-size:13px">The code is valid for 10 minutes. If you did not ask for this, you can ignore this email.</p>
    ${contact ? `<p style="color:#94a3b8;font-size:12px;margin-top:24px">${contact}</p>` : ''}</div>`;
  return { text, html };
}
