import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { SalesBotContext } from './sales-bot-context.service';

export type SalesBotTurn = { role: 'customer' | 'bot' | 'agent'; text: string };

export type SalesBotOrderItem = {
  product_id: number;
  variant_id?: number | null;
  product_name?: string;
  variant_name?: string;
  quantity: number;
  unit_price?: number;
};

export type SalesBotOrder = {
  items?: SalesBotOrderItem[];
  customer_name?: string;
  customer_phone?: string;
  address?: string;
  payment_method?: string;
  /** Delivery zone area the customer is in (the backend calculates the fee) */
  delivery_area?: string | null;
  delivery_fee?: number | null;
  summary_shown?: boolean;
  confirm_order?: boolean;
};

export type SalesBotResult = {
  reply: string;
  photo_product_ids: number[];
  order: SalesBotOrder | null;
  booking: { service_id?: number; service_name?: string; date?: string; time?: string; customer_name?: string; notes?: string; confirm?: boolean } | null;
  lead: { need?: string; budget?: string; location?: string; contact_time?: string; customer_name?: string; notes?: string } | null;
  handoff: { needed?: boolean; reason?: string } | null;
  /** Special requests ("quick delivery", "call before coming"): about the order → order note, else customer note */
  notes: Array<{ text: string; about?: 'order' | 'customer' }>;
  /** Customer wants to change a placed order (items = the FULL new item list, when items change) */
  order_change: {
    order_id?: number; request?: string; items?: SalesBotOrderItem[]; address?: string;
    customer_name?: string; customer_phone?: string; delivery_area?: string;
  } | null;
  /** Customer wants to cancel a placed order */
  cancel_request: { order_id?: number; reason?: string } | null;
  /** Customer asked for the invoice / bill of an order (or a booking) */
  send_invoice: { order_id?: number; booking_id?: number } | null;
  /** Customer wants to change an open booking (new date / time / service) */
  booking_change?: { booking_id?: number; request?: string; service_id?: number; date?: string; time?: string; notes?: string } | null;
  /** Customer wants to cancel an open booking */
  booking_cancel?: { booking_id?: number; reason?: string } | null;
  /** the bot's short notes about this customer (kept in the session, sent back with the next messages) */
  memory?: string | null;
  /** how close the customer is to buying (none | browsing | interested | ready) */
  interest?: 'none' | 'browsing' | 'interested' | 'ready' | null;
  /** what they want and what is missing – used for follow-ups */
  followup_note?: string | null;
  /** a safety check changed the answer (e.g. "confirm_asked_again", "stuck:repeat") */
  guard?: string | null;
  language: string;
  tools_used: string[];
  parse_error?: boolean;
  usage: {
    model: string; input_tokens: number; cached_tokens: number; output_tokens: number;
    thinking_tokens?: number; cost_usd: number; calls?: number; cache?: string; latency_ms: number;
  };
};

export type SalesBotRequest = {
  company_id: number;
  customer_id: number | null;
  message: string;
  history: SalesBotTurn[];
  session: Record<string, unknown>;
  media?: { mime_type: string; data_b64: string } | null;
  /** Business data for this reply – the Python bot does not read our database. */
  context: SalesBotContext;
};

/** HTTP client for the Python sales bot (FastAPI, POST /reply). */
@Injectable()
export class SalesBotClient {
  static baseUrl(): string {
    return String(process.env.SALES_BOT_URL ?? '').trim().replace(/\/+$/, '');
  }

  static isConfigured(): boolean {
    return Boolean(SalesBotClient.baseUrl());
  }

  async reply(request: SalesBotRequest): Promise<SalesBotResult> {
    const base = SalesBotClient.baseUrl();
    if (!base) {
      throw new ServiceUnavailableException('The sales bot is not configured (SALES_BOT_URL).');
    }
    const timeoutMs = Number(process.env.SALES_BOT_TIMEOUT_MS ?? 90000) || 90000;
    let response: Response;
    try {
      response = await fetch(`${base}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bot-Key': String(process.env.SALES_BOT_API_KEY ?? '') },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ServiceUnavailableException(`The sales bot is not reachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 300);
      throw new ServiceUnavailableException(`The sales bot answered ${response.status}: ${text}`);
    }
    const result = (await response.json()) as SalesBotResult;
    return {
      ...result,
      reply: String(result.reply ?? '').trim(),
      photo_product_ids: Array.isArray(result.photo_product_ids) ? result.photo_product_ids.map(Number).filter((id) => id > 0) : [],
      tools_used: Array.isArray(result.tools_used) ? result.tools_used : [],
      notes: Array.isArray(result.notes)
        ? result.notes.filter((note) => note && String(note.text ?? '').trim()).map((note) => ({ text: String(note.text).trim().slice(0, 500), about: note.about === 'order' ? 'order' : 'customer' }))
        : [],
      order_change: result.order_change && typeof result.order_change === 'object' ? result.order_change : null,
      cancel_request: result.cancel_request && typeof result.cancel_request === 'object' ? result.cancel_request : null,
      send_invoice: result.send_invoice && typeof result.send_invoice === 'object' ? result.send_invoice : null,
      booking_change: result.booking_change && typeof result.booking_change === 'object' ? result.booking_change : null,
      booking_cancel: result.booking_cancel && typeof result.booking_cancel === 'object' ? result.booking_cancel : null,
      memory: typeof result.memory === 'string' && result.memory.trim() ? result.memory.trim().slice(0, 600) : null,
      guard: typeof result.guard === 'string' ? result.guard : null,
      interest: ['none', 'browsing', 'interested', 'ready'].includes(String(result.interest)) ? result.interest : null,
      followup_note: typeof result.followup_note === 'string' && result.followup_note.trim() ? result.followup_note.trim().slice(0, 300) : null,
      usage: {
        model: String(result.usage?.model ?? ''),
        input_tokens: Number(result.usage?.input_tokens ?? 0),
        cached_tokens: Number(result.usage?.cached_tokens ?? 0),
        output_tokens: Number(result.usage?.output_tokens ?? 0),
        thinking_tokens: Number(result.usage?.thinking_tokens ?? 0),
        cost_usd: Number(result.usage?.cost_usd ?? 0),
        calls: Number(result.usage?.calls ?? 1),
        cache: String(result.usage?.cache ?? 'none'),
        latency_ms: Number(result.usage?.latency_ms ?? 0),
      },
    };
  }
}
