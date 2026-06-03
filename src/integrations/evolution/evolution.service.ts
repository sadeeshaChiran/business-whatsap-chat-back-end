import { BadRequestException, Injectable } from '@nestjs/common';
import {
  parseEvolutionFindChats,
  parseEvolutionFindMessages,
  type EvolutionInboxChat,
  type EvolutionInboxMessage,
} from './evolution-inbox.util';
import {
  parseEvolutionQrResponse,
  type EvolutionQrPayload,
} from './evolution-qr.util';

type EvolutionConfig = {
  baseUrl: string;
  apiKey: string;
};

export type EvolutionInstanceSettingsOverrides = {
  readMessages?: boolean;
  alwaysOnline?: boolean;
  groupsIgnore?: boolean;
};

export type EvolutionInstanceSettings = {
  rejectCall: boolean;
  groupsIgnore: boolean;
  alwaysOnline: boolean;
  readMessages: boolean;
  readStatus: boolean;
  syncFullHistory: boolean;
};

@Injectable()
export class EvolutionService {
  private getConfig(): EvolutionConfig {
    const rawBase =
      (process.env.EVOLUTION_API_BASE ?? process.env.EVOLUTION_BASE_URL ?? '').trim();
    // Some deployments proxy Evolution API under `/manager` (same origin as Manager UI).
    // So we must NOT blindly strip `/manager` here.
    const baseUrl = rawBase.replace(/\/+$/, '');
    const apiKey =
      (process.env.EVOLUTION_API_KEY ?? process.env.EVOLUTION_SECURE_KEY ?? '').trim();

    if (!baseUrl) {
      throw new BadRequestException('EVOLUTION_API_BASE is not configured');
    }
    if (!apiKey) {
      throw new BadRequestException('EVOLUTION_API_KEY is not configured');
    }
    return { baseUrl, apiKey };
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    overrideApiKey?: string,
  ): Promise<T> {
    const cfg = this.getConfig();
    const url = `${cfg.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const apikey = (overrideApiKey ?? cfg.apiKey).trim();

    const res = await fetch(url, {
      ...init,
      headers: {
        apikey,
        ...(init.headers ?? {}),
      },
    });

    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }

    if (!res.ok) {
      if (contentType.includes('text/html')) {
        throw new BadRequestException(
          'Evolution base URL points to the Manager UI (HTML). Please set EVOLUTION_API_BASE to the Evolution API server base URL that supports /instance and /message/sendText.',
        );
      }
      const message =
        typeof json === 'string'
          ? json
          : json?.message ??
            json?.error ??
            `Evolution API error (${res.status})`;
      if (res.status === 404 && message === 'Not Found') {
        throw new BadRequestException(
          'Evolution API returned 404 for this base URL. EVOLUTION_API_BASE must be the Evolution API server base URL (not just the Manager UI). Ask your Evolution provider for the API base that supports /instance and /message/sendText.',
        );
      }
      throw new BadRequestException(message);
    }

    if (contentType.includes('text/html')) {
      throw new BadRequestException(
        'Evolution base URL returned HTML (Manager UI). Please set EVOLUTION_API_BASE to the Evolution API server base URL.',
      );
    }
    return json as T;
  }

  private getWebhookUrl(): string | null {
    const url = (process.env.EVOLUTION_WEBHOOK_URL ?? '').trim();
    return url || null;
  }

  private getWebhookEvents(): string[] {
    const raw = (process.env.EVOLUTION_WEBHOOK_EVENTS ?? 'MESSAGES_UPSERT').trim();
    const events = raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return events.length > 0 ? events : ['MESSAGES_UPSERT'];
  }

  private webhookByEventsEnabled(): boolean {
    return (
      (process.env.EVOLUTION_WEBHOOK_BY_EVENTS ?? 'true').trim().toLowerCase() !==
      'false'
    );
  }

  private webhookBase64Enabled(): boolean {
    return (
      (process.env.EVOLUTION_WEBHOOK_BASE64 ?? 'false').trim().toLowerCase() ===
      'true'
    );
  }

  /** Payload for POST /instance/create `webhook` field (Evolution v2). */
  private buildCreateInstanceWebhook() {
    const url = this.getWebhookUrl();
    if (!url) {
      return undefined;
    }
    return {
      url,
      byEvents: this.webhookByEventsEnabled(),
      base64: this.webhookBase64Enabled(),
      events: this.getWebhookEvents(),
    };
  }

  /** Payload for POST /webhook/set/{instance} (Evolution v2). */
  private buildSetWebhookBody() {
    const url = this.getWebhookUrl();
    if (!url) {
      return null;
    }
    return {
      enabled: true,
      url,
      webhookByEvents: this.webhookByEventsEnabled(),
      webhookBase64: this.webhookBase64Enabled(),
      events: this.getWebhookEvents(),
    };
  }

  isWebhookAutoConfigureEnabled(): boolean {
    return Boolean(this.getWebhookUrl());
  }

  /**
   * Enables instance webhook using EVOLUTION_WEBHOOK_URL and EVOLUTION_WEBHOOK_EVENTS.
   * No-op when EVOLUTION_WEBHOOK_URL is unset.
   */
  async configureInstanceWebhook(
    instanceName: string,
    overrideApiKey?: string,
  ): Promise<unknown | null> {
    const body = this.buildSetWebhookBody();
    if (!body) {
      return null;
    }
    return this.request<unknown>(
      `/webhook/set/${encodeURIComponent(instanceName)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      overrideApiKey,
    );
  }

  /** Env flag: true unless explicitly false/0/no/off. */
  private envFlagEnabled(envName: string, defaultEnabled = true): boolean {
    const raw = process.env[envName]?.trim().toLowerCase();
    if (!raw) {
      return defaultEnabled;
    }
    if (['false', '0', 'no', 'off'].includes(raw)) {
      return false;
    }
    if (['true', '1', 'yes', 'on'].includes(raw)) {
      return true;
    }
    return defaultEnabled;
  }

  getInstanceSettingsDefaults(): Pick<
    EvolutionInstanceSettings,
    'readMessages' | 'alwaysOnline' | 'groupsIgnore'
  > {
    return {
      readMessages: this.envFlagEnabled('EVOLUTION_READ_MESSAGES', true),
      alwaysOnline: this.envFlagEnabled('EVOLUTION_ALWAYS_ONLINE', true),
      groupsIgnore: this.envFlagEnabled('EVOLUTION_GROUPS_IGNORE', true),
    };
  }

  /** Same toggles as Evolution Manager → instance settings. Env defaults; request can override. */
  buildInstanceSettingsBody(
    overrides?: EvolutionInstanceSettingsOverrides,
  ): EvolutionInstanceSettings {
    const defaults = this.getInstanceSettingsDefaults();
    return {
      rejectCall: false,
      groupsIgnore: overrides?.groupsIgnore ?? defaults.groupsIgnore,
      alwaysOnline: overrides?.alwaysOnline ?? defaults.alwaysOnline,
      readMessages: overrides?.readMessages ?? defaults.readMessages,
      readStatus: false,
      syncFullHistory: false,
    };
  }

  /**
   * Apply read-messages / always-online after create or when connected.
   * Evolution v2: POST /settings/set/{instance}
   */
  async applyInstanceSettings(
    instanceName: string,
    overrideApiKey?: string,
    settingsOverrides?: EvolutionInstanceSettingsOverrides,
  ): Promise<unknown> {
    const settings = this.buildInstanceSettingsBody(settingsOverrides);
    try {
      return await this.request<unknown>(
        `/settings/set/${encodeURIComponent(instanceName)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        },
        overrideApiKey,
      );
    } catch {
      return await this.request<unknown>(
        `/settings/set/${encodeURIComponent(instanceName)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reject_call: settings.rejectCall,
            groups_ignore: settings.groupsIgnore,
            always_online: settings.alwaysOnline,
            read_messages: settings.readMessages,
            read_status: settings.readStatus,
            sync_full_history: settings.syncFullHistory,
          }),
        },
        overrideApiKey,
      );
    }
  }

  async findChats(instanceName: string, overrideApiKey?: string) {
    const raw = await this.request<unknown>(
      `/chat/findChats/${encodeURIComponent(instanceName)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      overrideApiKey,
    );
    return parseEvolutionFindChats(raw);
  }

  async findMessages(
    instanceName: string,
    remoteJid: string,
    overrideApiKey?: string,
    limit = 80,
  ): Promise<EvolutionInboxMessage[]> {
    const raw = await this.request<unknown>(
      `/chat/findMessages/${encodeURIComponent(instanceName)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          where: { key: { remoteJid } },
          page: 1,
          offset: limit,
        }),
      },
      overrideApiKey,
    );
    return parseEvolutionFindMessages(raw, remoteJid);
  }

  async createInstance(
    instanceName: string,
    phoneDigits?: string,
    overrideApiKey?: string,
    settingsOverrides?: EvolutionInstanceSettingsOverrides,
  ) {
    const integration =
      (process.env.EVOLUTION_INTEGRATION ?? 'WHATSAPP-BAILEYS').trim();
    const settings = this.buildInstanceSettingsBody(settingsOverrides);
    const body: Record<string, unknown> = {
      instanceName,
      integration,
      qrcode: true,
      readMessages: settings.readMessages,
      alwaysOnline: settings.alwaysOnline,
      groupsIgnore: settings.groupsIgnore,
      read_messages: settings.readMessages,
      always_online: settings.alwaysOnline,
      groups_ignore: settings.groupsIgnore,
    };
    if (phoneDigits) {
      body.number = phoneDigits;
    }
    const webhook = this.buildCreateInstanceWebhook();
    if (webhook) {
      body.webhook = webhook;
    }
    return this.request<any>(
      '/instance/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      overrideApiKey,
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getConnectionState(instanceName: string, overrideApiKey?: string) {
    return this.request<{ instance?: { state?: string } }>(
      `/instance/connectionState/${encodeURIComponent(instanceName)}`,
      { method: 'GET' },
      overrideApiKey,
    );
  }

  async restartInstance(instanceName: string, overrideApiKey?: string) {
    return this.request<unknown>(
      `/instance/restart/${encodeURIComponent(instanceName)}`,
      { method: 'POST' },
      overrideApiKey,
    );
  }

  async logoutInstance(instanceName: string, overrideApiKey?: string) {
    return this.request<unknown>(
      `/instance/logout/${encodeURIComponent(instanceName)}`,
      { method: 'DELETE' },
      overrideApiKey,
    );
  }

  async getConnectQr(
    instanceName: string,
    overrideApiKey?: string,
    phoneE164?: string,
  ) {
    const query =
      phoneE164 && /^\d{8,15}$/.test(phoneE164)
        ? `?number=${encodeURIComponent(phoneE164)}`
        : '';
    return this.request<unknown>(
      `/instance/connect/${encodeURIComponent(instanceName)}${query}`,
      { method: 'GET' },
      overrideApiKey,
    );
  }

  parseQrPayload(payload: unknown): EvolutionQrPayload {
    return parseEvolutionQrResponse(payload);
  }

  private hasUsableQr(payload: EvolutionQrPayload) {
    return Boolean(payload.qr_image || payload.pairing_code);
  }

  /**
   * Evolution often returns `{ count: 0 }` until Baileys emits a QR.
   * Restart + poll connect; try instance token then global key.
   */
  async fetchQrForInstance(
    instanceName: string,
    instanceApiKey?: string,
    phoneDigits?: string,
  ): Promise<EvolutionQrPayload & { connection_state: string | null; last_raw: unknown }> {
    const keys = [
      instanceApiKey?.trim(),
      this.getConfig().apiKey,
    ].filter((value, index, list): value is string => {
      return Boolean(value) && list.indexOf(value) === index;
    });

    let connection_state: string | null = null;
    let last_raw: unknown = null;
    let best: EvolutionQrPayload = {
      qr_image: null,
      pairing_code: null,
      link_code: null,
      raw_count: null,
    };

    const attemptConnect = async () => {
      for (const key of keys) {
        try {
          const stateRes = await this.getConnectionState(instanceName, key);
          connection_state = stateRes?.instance?.state ?? connection_state;
          if (connection_state === 'open') {
            throw new BadRequestException(
              'WhatsApp is already connected for this instance. Disconnect it in Evolution Manager if you need a new QR.',
            );
          }
        } catch (error) {
          if (error instanceof BadRequestException) {
            throw error;
          }
        }

        last_raw = await this.getConnectQr(instanceName, key, phoneDigits);
        const parsed = this.parseQrPayload(last_raw);
        best = parsed;
        if (this.hasUsableQr(parsed)) {
          return parsed;
        }
      }
      return null;
    };

    await this.restartInstance(instanceName, keys[0]).catch(() => undefined);
    await this.sleep(2500);

    const maxAttempts = Number(process.env.EVOLUTION_QR_POLL_ATTEMPTS ?? 6);
    const delayMs = Number(process.env.EVOLUTION_QR_POLL_DELAY_MS ?? 2000);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const parsed = await attemptConnect();
      if (parsed) {
        return { ...parsed, connection_state, last_raw };
      }
      if (attempt === 2 && connection_state === 'connecting') {
        await this.logoutInstance(instanceName, keys[0]).catch(() => undefined);
        await this.sleep(1500);
      }
      if (attempt < maxAttempts - 1) {
        await this.sleep(delayMs);
      }
    }

    return { ...best, connection_state, last_raw };
  }

  managerUrl(): string {
    const base = this.getConfig().baseUrl.replace(/\/+$/, '');
    return `${base}/manager`;
  }

  qrUnavailableMessage(payload: EvolutionQrPayload): string {
    const countHint =
      payload.raw_count != null ? ` (Evolution count=${payload.raw_count})` : '';
    return (
      `Evolution did not return a scannable QR code${countHint}. ` +
      `This is usually fixed on the Evolution server: set or update CONFIG_SESSION_PHONE_VERSION in .env ` +
      `(see WhatsApp Web → Settings → version at the bottom), restart Evolution, then try again. ` +
      `You can also open Evolution Manager (${this.managerUrl()}) to scan the QR there.`
    );
  }

  /** Instance-scoped token returned by POST /instance/create (Evolution v2 `hash` field). */
  extractInstanceToken(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const record = payload as Record<string, unknown>;
    const candidates = [
      record.hash,
      record.token,
      record.apikey,
      record.instanceToken,
      record.instance_token,
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    const nested = record.instance;
    if (nested && typeof nested === 'object') {
      const inner = nested as Record<string, unknown>;
      for (const key of ['token', 'hash', 'apikey'] as const) {
        if (typeof inner[key] === 'string' && inner[key].trim()) {
          return inner[key].trim();
        }
      }
    }
    return null;
  }
}

