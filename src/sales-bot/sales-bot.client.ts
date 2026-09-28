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
