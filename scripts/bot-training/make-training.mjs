#!/usr/bin/env node
/**
 * Bot training for ANY company, from one JSON file – no code change needed for a new client.
 *
 *   node scripts/bot-training/make-training.mjs scripts/bot-training/clients/my-shop.json > my-shop-training.sql
 *   psql "$PRODUCT_DATABASE_URL" -f my-shop-training.sql
 *
 * The JSON (copy template.json) holds: the admin email (finds the company), bot settings (name, tone, greeting,
 * about, hours, payment, language), how to address customers, delivery zones, services (salons / clinics),
 * policies, sales-style examples and FAQs. Safe to run again: it replaces only the rows it wrote before
 * (rows the owner added in the dashboard stay).
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/bot-training/make-training.mjs <client.json> > training.sql'); process.exit(1); }
const c = JSON.parse(readFileSync(file, 'utf8'));
const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };
const q = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const num = (n) => (n == null || n === '' ? 'NULL' : Number(n));

need(c.admin_email, 'admin_email is required (the company admin login email)');
const bot = c.bot ?? {};
need(bot.name, 'bot.name is required');
need(String(bot.tone ?? '').length <= 255, 'bot.tone: max 255 characters');
need(String(bot.opening_hours ?? '').length <= 255, 'bot.opening_hours: max 255 characters');
need(['auto', 'sinhala', 'sinhala_latin', 'tamil', 'english'].includes(bot.default_language ?? 'auto'), 'bot.default_language: auto / sinhala / tamil / english');
need(['products', 'services', 'both'].includes(bot.sells ?? 'products'), 'bot.sells: products / services / both');
need(bot.booking_capacity == null || (Number.isInteger(bot.booking_capacity) && bot.booking_capacity >= 1), 'bot.booking_capacity: whole number, 1 or more (bookings at the same time)');

// ---- general rules every shop gets (each can be switched off or replaced in the JSON) ----
const address = {
  madam_sir: 'Address the customer as "Madam" or "Sir" (Sinhala "මැඩම්" / "සර්") in a warm way, like the shop staff do. Choose it from their name or what they said (a man\'s name, "mage wife" -> Sir; a woman\'s name, "mama amma" -> Madam). If you really cannot tell, use their name or no title - never a wrong one.',
  name: 'Address customers by their first name once you know it, never with Madam / Sir.',
  auto: 'Say Madam only when you know it is a woman and Sir only when you know it is a man; not sure -> no title, use their first name once you know it.',
}[c.address_customers ?? 'auto'];
need(address, 'address_customers: madam_sir / name / auto');
const DEFAULT_POLICIES = [
  ['Respect', `Always polite, warm and patient. ${address} Never argue, never blame the customer, never rush them.`],
  ['Listen first', 'Answer exactly what the customer asks first. Many customers check several products before buying: help them, do not push. Ask for name and address only once, when they say they are ready to order.'],
  ['Honesty', 'Only use products, prices, stock and policies the shop gave you. Never invent a product, price, discount, delivery time or promise. Not sure -> say a team member will confirm.'],
  ['Complaints', 'If something went wrong (late, damaged, wrong item), apologise sincerely first, ask for the order details and a photo if useful, and hand over to a team member. Never promise a refund yourself.'],
  ['Hand over to a person', 'Hand over to a team member when the customer asks for a person, is upset, has a complaint, a bulk order, a payment problem, or asks something not in your knowledge.'],
];
const policies = [...(c.use_default_policies === false ? [] : DEFAULT_POLICIES.filter(([t]) => !(c.policies ?? []).some((p) => p.title === t))),
  ...(c.policies ?? []).map((p) => [p.title, p.text])];
const styles = (c.style_examples ?? []).map((s) => [s.customer, s.reply]);
const faqs = (c.faqs ?? []).map((f) => [f.question, f.answer]);
for (const [a, b] of [...policies, ...styles, ...faqs]) need(a && b, `empty training row: ${a ?? b}`);
const faqChars = faqs.reduce((n, [a, b]) => n + a.length + b.length + 4, 0);
if (faqChars > 6000) console.error(`warning: FAQs are ${faqChars} chars (over 6000 they are searched instead of always in the prompt)`);
const zones = c.delivery_zones ?? [];
for (const z of zones) need(z.area && z.fee != null, `delivery zone needs area and fee: ${JSON.stringify(z)}`);
for (const z of zones) need(String(z.area ?? '').length <= 120, `delivery zone area: max 120 characters (${z.area})`);
const services = c.services ?? [];
for (const s of services) need(s.name && s.price != null, `service needs name and price: ${JSON.stringify(s)}`);
for (const s of services) need(String(s.price_note ?? '').length <= 50, `service price_note: max 50 characters (${s.name}: ${s.price_note})`);
for (const s of services) need(String(s.name ?? '').length <= 255, `service name: max 255 characters (${s.name})`);
if (errors.length) { console.error(errors.map((e) => `error: ${e}`).join('\n')); process.exit(1); }

const rows = [...policies.map(([a, b]) => ['policy', a, b]), ...styles.map(([a, b]) => ['style', a, b]), ...faqs.map(([a, b]) => ['faq', a, b])];
const marker = `[training:${String(c.key ?? c.admin_email).toLowerCase()}]`;
const allQuestions = [...new Set([...rows.map((r) => r[1]), ...(c.old_questions ?? [])])];

const sql = `-- Bot training for ${bot.name} (${c.admin_email}) – generated by scripts/bot-training/make-training.mjs from ${file}
-- ${policies.length} policies, ${styles.length} style examples, ${faqs.length} FAQs (${faqChars} chars), ${zones.length} delivery zones, ${services.length} services
-- ${marker} safe to run again
BEGIN;
DO $$
DECLARE cid BIGINT;
BEGIN
  SELECT c.id INTO cid FROM companies c JOIN app_user u ON u.id = c.admin_user_id WHERE LOWER(u.email) = LOWER(${q(c.admin_email)}) LIMIT 1;
  IF cid IS NULL THEN RAISE EXCEPTION 'company with admin ${c.admin_email} not found – create the account first'; END IF;

  INSERT INTO bot_sales_settings (company_id, bot_name, tone, default_language, greeting, about, opening_hours, payment_methods,
      sells, auto_send_invoice, followup_enabled, free_delivery_over, auto_enable_new_customers, booking_capacity, created_at, updated_at)
  VALUES (cid, ${q(bot.name)}, ${q(bot.tone ?? 'friendly, short, helpful')}, ${q(bot.default_language ?? 'auto')}, ${q(bot.greeting ?? '')},
      ${q(bot.about ?? '')}, ${q(bot.opening_hours ?? '')}, ${q(bot.payment_methods ?? 'Cash on delivery')}, ${q(bot.sells ?? 'products')},
      ${bot.auto_send_invoice === false ? 'FALSE' : 'TRUE'}, ${bot.followup_enabled === false ? 'FALSE' : 'TRUE'}, ${num(bot.free_delivery_over)},
      ${bot.auto_enable_new_customers === false ? 'FALSE' : 'TRUE'}, ${num(bot.booking_capacity ?? 1)}, NOW(), NOW())
  ON CONFLICT (company_id) DO UPDATE SET bot_name = EXCLUDED.bot_name, tone = EXCLUDED.tone, default_language = EXCLUDED.default_language,
      greeting = EXCLUDED.greeting, about = EXCLUDED.about, opening_hours = EXCLUDED.opening_hours, payment_methods = EXCLUDED.payment_methods,
      sells = EXCLUDED.sells, auto_send_invoice = EXCLUDED.auto_send_invoice, followup_enabled = EXCLUDED.followup_enabled,
      free_delivery_over = EXCLUDED.free_delivery_over, auto_enable_new_customers = EXCLUDED.auto_enable_new_customers,
      booking_capacity = EXCLUDED.booking_capacity, updated_at = NOW();
${zones.length ? `
  DELETE FROM bot_delivery_zone WHERE company_id = cid;
  INSERT INTO bot_delivery_zone (company_id, area, fee, days, included_kg, per_extra_kg, weight_rounding) VALUES
  ${zones.map((z) => `(cid, ${q(z.area)}, ${num(z.fee)}, ${q(z.days ?? '')}, ${num(z.included_kg)}, ${num(z.per_extra_kg)}, ${q(z.weight_rounding ?? 'up')})`).join(',\n  ')};` : '  -- no delivery_zones in the JSON: zones unchanged'}
${services.length ? `
  DELETE FROM bot_service WHERE company_id = cid AND name IN (${services.map((s) => q(s.name)).join(', ')});
  INSERT INTO bot_service (company_id, name, description, price, price_note, duration_min, is_active, is_available, created_at, updated_at) VALUES
  ${services.map((s) => `(cid, ${q(s.name)}, ${q(s.description ?? '')}, ${num(s.price)}, ${q(s.price_note ?? '')}, ${num(s.duration_min)}, TRUE, TRUE, NOW(), NOW())`).join(',\n  ')};` : ''}

  DELETE FROM bot_training_data WHERE company_id = cid AND question IN (
    ${allQuestions.map(q).join(',\n    ')});
  INSERT INTO bot_training_data (company_id, category, question, answer, language, is_active) VALUES
  ${rows.map(([cat, a, b]) => `(cid, ${q(cat)}, ${q(a)}, ${q(b)}, 'auto', TRUE)`).join(',\n  ')};

  RAISE NOTICE '% (company %) trained: % policies, % styles, % FAQs', ${q(bot.name)}, cid, ${policies.length}, ${styles.length}, ${faqs.length};
END $$;
COMMIT;
`;
process.stdout.write(sql);
