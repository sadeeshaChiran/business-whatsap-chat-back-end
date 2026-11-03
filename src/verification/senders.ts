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
 * SMS code with Notify.lk (Sri Lanka): NOTIFYLK_USER_ID, NOTIFYLK_API_KEY, NOTIFYLK_SENDER_ID (your approved sender
 * name; "NotifyDEMO" only works for numbers added to the Notify.lk test list).
 */
export async function sendSmsCode(phone: string, code: string): Promise<boolean> {
  if (!env('NOTIFYLK_USER_ID') || !env('NOTIFYLK_API_KEY')) {
    logger.error('NOTIFYLK_USER_ID / NOTIFYLK_API_KEY are not set – SMS codes cannot be sent.');
    return false;
  }
  try {
    const params = new URLSearchParams({
      user_id: env('NOTIFYLK_USER_ID'), api_key: env('NOTIFYLK_API_KEY'), sender_id: env('NOTIFYLK_SENDER_ID') || 'NotifyDEMO',
      to: phone, message: `${code} is your ${BrandingService.current().name} code. It is valid for 10 minutes. Do not share it.`,
    });
    const base = (env('NOTIFYLK_BASE_URL') || 'https://app.notify.lk/api/v1').replace(/\/+$/, '');
    const response = await fetch(`${base}/send?${params.toString()}`, { signal: AbortSignal.timeout(15000) });
    const body = (await response.json().catch(() => ({}))) as { status?: string; data?: unknown; message?: string; errors?: unknown };
    // Notify.lk answers {"status":"success","data":"Sent"} – anything else is a failure (wrong key, no credit, bad number …)
    const ok = response.ok && String(body.status ?? '').toLowerCase() === 'success';
    if (!ok) logger.warn(`SMS code to ${phone} failed: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
    return ok;
  } catch (error) {
    logger.warn(`SMS code to ${phone} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Mobile number codes go by SMS (no WhatsApp needed). Dev mode logs the code instead. */
export async function sendPhoneCode(phone: string, code: string): Promise<'sms' | 'dev' | null> {
  if (await sendSmsCode(phone, code)) return 'sms';
  if (otpDevMode()) { logger.warn(`[dev] SMS code for ${phone}: ${code}`); return 'dev'; }
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
