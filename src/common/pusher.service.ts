import { Injectable, Logger } from '@nestjs/common';
import Pusher from 'pusher';

/**
 * Real-time events for the inbox. Company channels are private ("private-company-<id>"):
 * the browser must be signed in and belong to that company (see RealtimeController).
 */
@Injectable()
export class PusherService {
  private static client: Pusher | null | undefined;
  private readonly logger = new Logger(PusherService.name);

  private get pusher(): Pusher | null {
    if (PusherService.client !== undefined) return PusherService.client;
    const appId = process.env.PUSHER_APP_ID?.trim();
    const key = process.env.PUSHER_KEY?.trim();
    const secret = process.env.PUSHER_SECRET?.trim();
    const host = process.env.PUSHER_HOST?.trim();
    const port = process.env.PUSHER_PORT?.trim();
    const scheme = process.env.PUSHER_SCHEME || 'https';
    if (appId && key && secret) {
      PusherService.client = new Pusher({
        appId,
        key,
        secret,
        cluster: process.env.PUSHER_CLUSTER?.trim() || 'mt1',
        useTLS: scheme === 'https',
        ...(host ? { host, port: port ? Number(port) : undefined } : {}),
      });
      this.logger.log('Pusher real-time updates enabled.');
    } else {
      PusherService.client = null;
      this.logger.log('Pusher is not configured – the inbox refreshes by polling.');
    }
    return PusherService.client;
  }

  get enabled(): boolean {
    return Boolean(this.pusher);
  }

  /** "company-12" → "private-company-12" (other channel names are kept). */
  static channelName(channel: string): string {
    return /^company-\d+$/.test(channel) ? `private-${channel}` : channel;
  }

  trigger(channel: string, event: string, data: unknown) {
    const client = this.pusher;
    if (!client) return;
    client.trigger(PusherService.channelName(channel), event, data).catch((err: unknown) => {
      this.logger.warn(`Pusher trigger failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Signs a private channel subscription for the browser. */
  authorize(socketId: string, channel: string) {
    const client = this.pusher;
    if (!client) return null;
    return client.authorizeChannel(socketId, channel);
  }
}
