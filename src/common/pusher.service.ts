import { Injectable } from '@nestjs/common';
import Pusher from 'pusher';

@Injectable()
export class PusherService {
  private pusher: Pusher | null = null;

  constructor() {
    const appId = process.env.PUSHER_APP_ID;
    const key = process.env.PUSHER_KEY;
    const secret = process.env.PUSHER_SECRET;
    const cluster = process.env.PUSHER_CLUSTER || 'mt1';
    const host = process.env.PUSHER_HOST;
    const port = process.env.PUSHER_PORT;
    const scheme = process.env.PUSHER_SCHEME || 'https';

    if (appId && key && secret) {
      this.pusher = new Pusher({
        appId,
        key,
        secret,
        cluster,
        useTLS: scheme === 'https',
        ...(host ? { host, port: port ? Number(port) : undefined } : {}),
      });
      console.log('Pusher initialized successfully.');
    } else {
      console.log('Pusher configuration missing. Real-time updates will run in mock mode.');
    }
  }

  trigger(channel: string, event: string, data: any) {
    if (this.pusher) {
      this.pusher.trigger(channel, event, data).catch(err => {
        console.error('Pusher trigger failed:', err);
      });
    } else {
      console.log(`[Pusher Mock] Channel: ${channel}, Event: ${event}, Data:`, data);
    }
  }
}
