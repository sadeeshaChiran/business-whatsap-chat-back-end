/**
 * Bot test set runner – replays real customer messages to the AI bot and scores the answers.
 * It does NOT send anything to customers, does not save orders and does not charge credits:
 * it only reads the database and calls the Python bot's /reply (that costs Gemini money, ~$0.3–1 for 180 cases).
 * It does not start the Nest app, so no background jobs (follow-ups, broadcasts, bot auto-on) run.
 *
 *   npm run build
 *   node dist/bot-eval/run-eval.js --cases bot-eval/cases.json --out bot-eval/base.json [--shop chu] [--limit 20] [--only chu-001-known]
 *   node dist/bot-eval/run-eval.js --compare bot-eval/base.json bot-eval/new.json
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { getDatabaseSsl, getSupabaseDatabaseUrl } from '../common/supabase-database';
import { BotOrder } from '../bot-admin/entities/bot-order.entity';
import { BotMessage } from '../bot-admin/entities/bot-message.entity';
import { BotTrainingData } from '../bot-admin/entities/bot-training-data.entity';
import { Company } from '../company/entities/company.entity';
import { Product } from '../products/entities/product.entity';
import { BotBooking } from '../sales-bot/entities/bot-booking.entity';
import { BotDeliveryZone } from '../sales-bot/entities/bot-delivery-zone.entity';
import { BotService } from '../sales-bot/entities/bot-service.entity';
import { SalesBotSettings } from '../sales-bot/entities/sales-bot-settings.entity';
import { SalesBotContextService, sriLankaNow } from '../sales-bot/sales-bot-context.service';
import { chatHistory } from '../sales-bot/sales-bot-engine.service';
import { SalesBotClient } from '../sales-bot/sales-bot.client';
import { compareRuns, type EvalCase, type RunRow, scoreCase, summarize } from './score';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function printSummary(title: string, s: ReturnType<typeof summarize>) {
  console.log(`\n=== ${title} ===`);
  console.log(`cases ${s.cases} · pass ${s.pass} (${s.pass_pct}%) · errors ${s.errors} · cost $${s.cost_usd} · $${s.cost_per_reply_usd}/reply · ${s.tokens_per_reply} tokens/reply`);
  for (const [shop, v] of Object.entries(s.by_shop)) console.log(`  ${shop.padEnd(10)} ${String(v.pass).padStart(3)}/${v.cases}  ${v.pass_pct}%`);
  console.log('  checks:');
  for (const [name, v] of Object.entries(s.by_check)) console.log(`    ${name.padEnd(20)} ${v.pass}/${v.run}  ${v.pass_pct}%`);
}

async function compare(a: string, b: string) {
  const before = JSON.parse(readFileSync(a, 'utf8')).rows as RunRow[];
  const after = JSON.parse(readFileSync(b, 'utf8')).rows as RunRow[];
  const result = compareRuns(before, after);
  printSummary(`BEFORE ${a}`, result.before);
  printSummary(`AFTER  ${b}`, result.after);
  const costChange = result.before.cost_per_reply_usd
    ? Math.round(((result.after.cost_per_reply_usd - result.before.cost_per_reply_usd) / result.before.cost_per_reply_usd) * 1000) / 10 : 0;
  console.log(`\ncost per reply: ${costChange > 0 ? '+' : ''}${costChange}% · pass: ${result.before.pass_pct}% -> ${result.after.pass_pct}%`);
  console.log(`\nNEWLY FAILING (${result.newly_failing.length}):`);
  for (const r of result.newly_failing) console.log(`  ${r.id}: ${r.fails.join(' | ')}\n      reply: ${r.reply.replace(/\n/g, ' ')}`);
  console.log(`NEWLY PASSING (${result.newly_passing.length}): ${result.newly_passing.join(', ')}`);
}

async function run() {
  const casesPath = arg('cases') ?? join(process.cwd(), 'bot-eval', 'cases.json');
  const outPath = arg('out') ?? join(process.cwd(), 'bot-eval', `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
  const shop = arg('shop');
  const only = arg('only');
  const limit = Number(arg('limit') ?? 0);
  const delayMs = Number(arg('delay') ?? 300);
  if (!SalesBotClient.isConfigured()) throw new Error('SALES_BOT_URL is not set in .env');

  let cases = (JSON.parse(readFileSync(casesPath, 'utf8')).cases ?? []) as EvalCase[];
  if (shop) cases = cases.filter((c) => c.shop === shop);
  if (only) cases = cases.filter((c) => only.split(',').includes(c.id));
  if (limit > 0) cases = cases.slice(0, limit);

  const ds = new DataSource({
    type: 'postgres',
    url: getSupabaseDatabaseUrl(),
    ssl: getDatabaseSsl(),
    entities: [join(__dirname, '..', '**', '*.entity.js')],
    synchronize: false,
    extra: { max: 3 },
  });
  await ds.initialize();
  const contextService = new SalesBotContextService(
    ds.getRepository(Company), ds.getRepository(SalesBotSettings), ds.getRepository(Product), ds.getRepository(BotService),
    ds.getRepository(BotDeliveryZone), ds.getRepository(BotTrainingData), ds.getRepository(BotOrder), ds.getRepository(BotBooking), ds,
  );
  const client = new SalesBotClient();
  const messages = ds.getRepository(BotMessage);

  const rows: RunRow[] = [];
  let i = 0;
  for (const testCase of cases) {
    i += 1;
    const started = Date.now();
    try {
      const [at] = await ds.query(`SELECT created_at::timestamptz AS created_at FROM bot_message WHERE id = $1`, [testCase.before_message_id]);
      const asOf = at?.created_at ? new Date(at.created_at) : undefined;
      const history = await chatHistory(messages, testCase.conversation_id, testCase.before_message_id);
      const context = await contextService.build(testCase.company_id, testCase.channel_user_id, testCase.platform || 'whatsapp', {
        conversationId: testCase.conversation_id, message: testCase.message, readOnly: true, asOf,
      });
      if (asOf) context.today = sriLankaNow(asOf).label;
      const orderItems: Record<number, number[]> = {};
      for (const orderId of testCase.checks.no_duplicate_order_of ?? []) {
        const items = await ds.query(`SELECT product_id FROM bot_order_item WHERE order_id = $1`, [orderId]);
        orderItems[orderId] = items.map((r: { product_id: number }) => Number(r.product_id));
      }
      const result = await client.reply({
        company_id: testCase.company_id,
        customer_id: testCase.channel_user_id,
        message: testCase.message,
        history,
        session: {},
        media: null,
        context,
      });
      const score = scoreCase(testCase, result, context, history, orderItems);
      rows.push({ ...score, reply: result.reply, usage: result.usage ?? null, ms: Date.now() - started });
      console.log(`${String(i).padStart(3)}/${cases.length} ${score.pass ? 'PASS' : 'FAIL'} ${testCase.id}${score.pass ? '' : `  ${score.fails.join(' | ')}`}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rows.push({ id: testCase.id, shop: testCase.shop, kind: testCase.kind, pass: false, checks: {}, fails: [`error: ${message}`], reply: '', usage: null, error: message, ms: Date.now() - started });
      console.log(`${String(i).padStart(3)}/${cases.length} ERROR ${testCase.id}  ${message.slice(0, 160)}`);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  await ds.destroy();
  const summary = summarize(rows);
  writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), cases: casesPath, summary, rows }, null, 1));
  printSummary(outPath, summary);
  const failing = rows.filter((r) => !r.pass);
  if (failing.length) {
    console.log(`\nFAILING (${failing.length}):`);
    for (const r of failing.slice(0, 60)) console.log(`  ${r.id}: ${r.fails.join(' | ')}\n      reply: ${r.reply.slice(0, 200).replace(/\n/g, ' ')}`);
  }
}

const cmp = process.argv.indexOf('--compare');
(cmp >= 0 ? compare(process.argv[cmp + 1], process.argv[cmp + 2]) : run()).catch((error) => {
  console.error(error);
  process.exit(1);
});
