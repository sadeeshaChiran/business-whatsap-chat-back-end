import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

@Injectable()
export class BotProxyService {
  getBaseUrl(): string {
    return this.readEnv('BOT_BASE_URL', 'http://localhost:5005').replace(
      /\/+$/,
      '',
    );
  }

  resolvePythonPath(subPath: string, method: string): string {
    const path = subPath.replace(/^\/+|\/+$/g, '');
    if (!path || path === 'health') {
      return '/bot/health';
    }
    if (path === 'chat' && method.toUpperCase() === 'POST') {
      return '/bot';
    }
    if (path === 'chat-v2' && method.toUpperCase() === 'POST') {
      return '/chat';
    }
    return `/bot/${path}`;
  }

  async forward(
    method: string,
    subPath: string,
    body?: unknown,
    authorization?: string,
  ): Promise<unknown> {
    const normalizedMethod = method.toUpperCase();
    const pythonPath = this.resolvePythonPath(subPath, normalizedMethod);
    const url = `${this.getBaseUrl()}${pythonPath}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: normalizedMethod,
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body:
          normalizedMethod === 'GET' || normalizedMethod === 'HEAD'
            ? undefined
            : JSON.stringify(body ?? {}),
      });
    } catch {
      throw new ServiceUnavailableException(
        `Python bot service is not reachable at ${this.getBaseUrl()}. ` +
          'Start it from the bot folder: python main.py',
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { error: text || 'Invalid bot response' };
    }

    if (!response.ok) {
      const message =
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        (payload as { error?: unknown }).error
          ? String((payload as { error: unknown }).error)
          : `Bot service error (${response.status})`;
      throw new ServiceUnavailableException(message);
    }

    return payload;
  }

  private readEnv(key: string, fallback: string): string {
    const direct = process.env[key]?.trim();
    if (direct) {
      return direct;
    }

    const botEnvPath = resolve(process.cwd(), '..', 'bot', '.env');
    if (!existsSync(botEnvPath)) {
      return fallback;
    }

    const content = readFileSync(botEnvPath, 'utf8');
    const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (!match) {
      return fallback;
    }

    return match[1].trim().replace(/^['"]|['"]$/g, '') || fallback;
  }
}
