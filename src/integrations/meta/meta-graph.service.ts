import { BadRequestException, Injectable } from '@nestjs/common';
import type { MetaPendingPage } from '../../meta/entities/meta-oauth-pending.entity';

export type MetaGraphConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
  scopes: string;
  configId: string;
};

export type MetaSocialPost = {
  id: string;
  platform: 'facebook' | 'instagram';
  message: string;
  image_urls: string[];
  permalink: string | null;
  created_time: string | null;
  media_type: string | null;
};

type GraphErrorBody = {
  error?: { message?: string; type?: string; code?: number };
};

@Injectable()
export class MetaGraphService {
  async fetchMessagingProfile(senderId: string, pageAccessToken: string, platform: 'messenger' | 'instagram'): Promise<{ name?: string; username?: string }> {
    return this.graphGet<{ name?: string; username?: string }>(
      '/'+encodeURIComponent(senderId), pageAccessToken,
      { fields: platform === 'instagram' ? 'username' : 'name' },
    );
  }

  getConfig(): MetaGraphConfig {
    const appId = process.env.META_APP_ID?.trim() ?? '';
    const appSecret = process.env.META_APP_SECRET?.trim() ?? '';
    const redirectUri = process.env.META_OAUTH_REDIRECT_URI?.trim() ?? '';
    const graphVersion =
      process.env.META_GRAPH_API_VERSION?.trim() || 'v19.0';
    const scopes =
      process.env.META_OAUTH_SCOPES?.trim() ||
      'pages_show_list,pages_read_engagement,pages_messaging,pages_manage_metadata,instagram_basic,instagram_manage_messages,business_management,' +
      // Social section: comments, posts, insights
      'pages_manage_engagement,pages_read_user_content,pages_manage_posts,read_insights,instagram_manage_comments,instagram_content_publish,instagram_manage_insights';
    const configId = process.env.META_OAUTH_CONFIG_ID?.trim() ?? '';

    if (!appId || !appSecret || !redirectUri) {
      throw new BadRequestException(
        'Meta integration is not configured. Set META_APP_ID, META_APP_SECRET, and META_OAUTH_REDIRECT_URI on the API server.',
      );
    }

    return { appId, appSecret, redirectUri, graphVersion, scopes, configId };
  }

  buildAuthUrl(state: string): string {
    const cfg = this.getConfig();
    const params = new URLSearchParams({
      client_id: cfg.appId,
      redirect_uri: cfg.redirectUri,
      state,
      response_type: 'code',
    });

    // Facebook Login for Business: permissions come from config_id — do not send scope.
    if (cfg.configId) {
      params.set('config_id', cfg.configId);
    } else {
      params.set('scope', cfg.scopes);
    }

    return `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth?${params.toString()}`;
  }

  frontendSuccessRedirect(query = '', returnPath?: string): string {
    const configured =
      process.env.META_OAUTH_SUCCESS_REDIRECT?.trim() ||
      'http://localhost:3000/channels/messenger';
    const base =
      returnPath === '/channels/messenger' || returnPath === '/channels/instagram'
        ? new URL(configured).origin + returnPath
        : configured;
    return query ? `${base}${base.includes('?') ? '&' : '?'}${query}` : base;
  }

  frontendErrorRedirect(message: string, returnPath?: string): string {
    const base = this.frontendSuccessRedirect('', returnPath);
    const params = new URLSearchParams({ meta: 'error', message });
    return `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
  }

  private graphUrl(path: string, cfg: MetaGraphConfig): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    // META_GRAPH_BASE_URL is only for automated tests (a local fake Meta server) – leave it empty in production
    const base = (process.env.META_GRAPH_BASE_URL?.trim() || 'https://graph.facebook.com').replace(/\/+$/, '');
    return `${base}/${cfg.graphVersion}${normalized}`;
  }

  private async graphRequest<T>(
    path: string,
    query: Record<string, string>,
    accessToken?: string,
  ): Promise<T> {
    const cfg = this.getConfig();
    const params = new URLSearchParams(query);
    if (accessToken) {
      params.set('access_token', accessToken);
    }
    const url = `${this.graphUrl(path, cfg)}?${params.toString()}`;
    const res = await fetch(url);
    const json = (await res.json()) as T & GraphErrorBody;
    if (!res.ok) {
      throw new BadRequestException(
        json.error?.message ?? `Meta Graph API request failed (${res.status})`,
      );
    }
    return json;
  }

  private graphGet<T>(
    path: string,
    accessToken: string,
    query: Record<string, string> = {},
  ): Promise<T> {
    return this.graphRequest<T>(path, query, accessToken);
  }

  async exchangeCodeForUserToken(code: string): Promise<string> {
    const cfg = this.getConfig();
    const shortLived = await this.graphRequest<{ access_token?: string }>(
      '/oauth/access_token',
      {
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        redirect_uri: cfg.redirectUri,
        code,
      },
    );
    const shortToken = shortLived.access_token?.trim();
    if (!shortToken) {
      throw new BadRequestException('Meta did not return an access token.');
    }

    const longLived = await this.graphRequest<{ access_token?: string }>(
      '/oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        fb_exchange_token: shortToken,
      },
    );
    const longToken = longLived.access_token?.trim();
    if (!longToken) {
      throw new BadRequestException(
        'Meta did not return a long-lived access token.',
      );
    }
    return longToken;
  }

  getEmbeddedSignupConfig() {
    const cfg = this.getConfig();
    const whatsappConfigId = process.env.META_WHATSAPP_CONFIG_ID?.trim() ?? '';
    if (!whatsappConfigId) {
      throw new BadRequestException('WhatsApp automatic setup requires META_WHATSAPP_CONFIG_ID on the API server.');
    }
    return { app_id: cfg.appId, config_id: whatsappConfigId, graph_version: cfg.graphVersion };
  }

  /**
   * Swaps the Embedded Signup code for a business token. Meta only accepts the swap when it matches how the code
   * was created, so we try, in order: no redirect_uri (documented for Embedded Signup), an empty redirect_uri, the
   * dashboard page the popup was opened from, and META_OAUTH_REDIRECT_URI. A rejected attempt does not use up the code.
   */
  async exchangeEmbeddedSignupCode(code: string, pageUrl?: string): Promise<string> {
    const cfg = this.getConfig();
    const candidates: Array<string | null> = [null, ''];
    for (const uri of [pageUrl?.trim(), pageUrl?.trim().replace(/\/+$/, '') + '/', cfg.redirectUri?.trim()]) {
      if (uri && uri !== '/' && !candidates.includes(uri)) candidates.push(uri);
    }
    let lastError = 'Meta did not return a WhatsApp access token.';
    for (const redirectUri of candidates) {
      const params = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, code: code.trim() });
      if (redirectUri !== null) params.set('redirect_uri', redirectUri);
      const response = await fetch(`${this.graphUrl('/oauth/access_token', cfg)}?${params.toString()}`, { method: 'GET' });
      const payload = (await response.json().catch(() => ({}))) as { access_token?: string } & GraphErrorBody;
      if (response.ok && payload.access_token?.trim()) return payload.access_token.trim();
      lastError = payload.error?.message ?? lastError;
      // only a redirect_uri mismatch is worth another try (expired / used codes fail the same way every time)
      if (!/redirect_uri/i.test(lastError)) break;
    }
    if (/redirect_uri/i.test(lastError)) {
      throw new BadRequestException(`Meta: ${lastError} – In the Meta app open Facebook Login for Business → Settings and add your dashboard address (${pageUrl || 'https://your-dashboard'}) to "Valid OAuth Redirect URIs", then try again.`);
    }
    if (/expired|has been used|already been used/i.test(lastError)) {
      throw new BadRequestException('The Meta code expired before it reached the server (codes last only a few minutes). Please run the setup again.');
    }
    throw new BadRequestException(`Meta: ${lastError}`);
  }

  /**
   * Tells Meta to send this Page's Messenger messages (and the linked Instagram account's DMs)
   * to our webhook. Without this step the webhook stays silent even when the app is set up correctly.
   */
  async subscribePageMessaging(pageId: string, pageAccessToken: string): Promise<void> {
    const cfg = this.getConfig();
    const params = new URLSearchParams({ subscribed_fields: 'messages,messaging_postbacks,message_deliveries,message_reads,feed' });
    const url = `${this.graphUrl(`/${encodeURIComponent(pageId)}/subscribed_apps`, cfg)}?${params.toString()}`;
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${pageAccessToken}` } });
    const payload = (await response.json().catch(() => ({}))) as { success?: boolean } & GraphErrorBody;
    if (!response.ok || payload.success !== true) {
      throw new BadRequestException(payload.error?.message ?? 'Meta could not subscribe this Page to the messaging webhook.');
    }
  }

  async subscribeWhatsappApp(wabaId: string, accessToken: string): Promise<void> {
    const cfg = this.getConfig();
    const url = this.graphUrl(`/${encodeURIComponent(wabaId)}/subscribed_apps`, cfg);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = (await response.json()) as { success?: boolean } & GraphErrorBody;
    if (!response.ok || payload.success !== true) {
      throw new BadRequestException(payload.error?.message ?? 'Meta could not subscribe the WhatsApp webhook.');
    }
  }

  async fetchWhatsappPhoneNumber(phoneNumberId: string, accessToken: string) {
    const result = await this.graphGet<{ id?: string; display_phone_number?: string; verified_name?: string }>(
      `/${encodeURIComponent(phoneNumberId)}`,
      accessToken,
      { fields: 'id,display_phone_number,verified_name' },
    );
    if (String(result.id ?? '') !== phoneNumberId.trim()) {
      throw new BadRequestException('The selected WhatsApp phone number was not returned by Meta.');
    }
    return {
      display_phone_number: String(result.display_phone_number ?? '').trim(),
      verified_name: String(result.verified_name ?? '').trim(),
    };
  }
  async fetchMetaUserId(userToken: string): Promise<string> {
    const me = await this.graphGet<{ id?: string }>('/me', userToken, {
      fields: 'id',
    });
    if (!me.id) {
      throw new BadRequestException('Meta user id was not returned.');
    }
    return me.id;
  }

  async fetchManagedPages(userToken: string): Promise<MetaPendingPage[]> {
    type AccountsResponse = {
      data?: Array<{
        id?: string;
        name?: string;
        access_token?: string;
        instagram_business_account?: { id?: string; username?: string };
      }>;
    };

    const response = await this.graphGet<AccountsResponse>(
      '/me/accounts',
      userToken,
      {
        fields:
          'id,name,access_token,instagram_business_account{id,username}',
        limit: '50',
      },
    );

    const pages = (response.data ?? [])
      .filter((row) => row.id && row.name && row.access_token)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        access_token: String(row.access_token),
        instagram_business_account_id:
          row.instagram_business_account?.id ?? null,
        instagram_username: row.instagram_business_account?.username ?? null,
      }));

    if (!pages.length) {
      throw new BadRequestException(
        'No Facebook Pages found for this account. You must be a Page admin.',
      );
    }

    return pages;
  }

  async refreshInstagramAccount(
    pageId: string,
    pageAccessToken: string,
  ): Promise<{ id: string | null; username: string | null }> {
    type PageResponse = {
      instagram_business_account?: { id?: string; username?: string };
      connected_instagram_account?: { id?: string; username?: string };
    };
    try {
      const response = await this.graphGet<PageResponse>(`/${pageId}`, pageAccessToken, {
        fields:
          'instagram_business_account{id,username},connected_instagram_account{id,username}',
      });
      const ig =
        response.instagram_business_account ??
        response.connected_instagram_account;
      return {
        id: ig?.id ? String(ig.id) : null,
        username: ig?.username ? String(ig.username) : null,
      };
    } catch {
      return { id: null, username: null };
    }
  }

  private async graphGetAttempt<T>(
    path: string,
    accessToken: string,
    query: Record<string, string> = {},
  ): Promise<{ data: T | null; error: string | null }> {
    try {
      const data = await this.graphGet<T>(path, accessToken, query);
      return { data, error: null };
    } catch (error) {
      const message =
        error instanceof BadRequestException
          ? String(error.message)
          : error instanceof Error
            ? error.message
            : 'Meta Graph API request failed.';
      return { data: null, error: message };
    }
  }

  async fetchFacebookPosts(
    pageId: string,
    pageAccessToken: string,
    limit = 20,
  ): Promise<{ posts: MetaSocialPost[]; errors: string[] }> {
    type PostRow = {
      id?: string;
      message?: string;
      created_time?: string;
      permalink_url?: string;
      full_picture?: string;
      attachments?: {
        data?: Array<{
          media?: { image?: { src?: string } };
          subattachments?: {
            data?: Array<{ media?: { image?: { src?: string } } }>;
          };
        }>;
      };
    };

    type PhotoRow = {
      id?: string;
      name?: string;
      created_time?: string;
      link?: string;
      images?: Array<{ source?: string; width?: number; height?: number }>;
    };

    const postFields =
      'id,message,created_time,permalink_url,full_picture,attachments{media,subattachments}';
    const photoFields = 'id,name,created_time,link,images';

    const attempts: Array<{
      label: string;
      path: string;
      fields: string;
      kind: 'post' | 'photo';
    }> = [
      { label: 'published_posts', path: `/${pageId}/published_posts`, fields: postFields, kind: 'post' },
      { label: 'posts', path: `/${pageId}/posts`, fields: postFields, kind: 'post' },
      { label: 'feed', path: `/${pageId}/feed`, fields: postFields, kind: 'post' },
      { label: 'photos', path: `/${pageId}/photos`, fields: photoFields, kind: 'photo' },
    ];

    const byId = new Map<string, MetaSocialPost>();
    const errors: string[] = [];

    for (const attempt of attempts) {
      const { data, error } = await this.graphGetAttempt<{ data?: PostRow[] | PhotoRow[] }>(
        attempt.path,
        pageAccessToken,
        {
          fields: attempt.fields,
          limit: String(limit),
        },
      );
      if (error) {
        errors.push(`${attempt.label}: ${error}`);
        continue;
      }
      const rows = data?.data ?? [];
      for (const row of rows) {
        if (attempt.kind === 'photo') {
          const photo = row as PhotoRow;
          const id = String(photo.id ?? '');
          if (!id || byId.has(`photo-${id}`)) {
            continue;
          }
          const imageUrl =
            [...(photo.images ?? [])].sort(
              (a, b) => Number(b.width ?? 0) - Number(a.width ?? 0),
            )[0]?.source ?? null;
          byId.set(`photo-${id}`, {
            id,
            platform: 'facebook',
            message: photo.name?.trim() ?? '',
            image_urls: imageUrl ? [imageUrl] : [],
            permalink: photo.link ?? `https://www.facebook.com/photo/?fbid=${id}`,
            created_time: photo.created_time ?? null,
            media_type: 'PHOTO',
          });
        } else {
          const post = row as PostRow;
          const id = String(post.id ?? '');
          if (!id || byId.has(`post-${id}`)) {
            continue;
          }
          byId.set(`post-${id}`, {
            id,
            platform: 'facebook',
            message: post.message?.trim() ?? '',
            image_urls: this.extractFacebookImages(post),
            permalink: post.permalink_url ?? null,
            created_time: post.created_time ?? null,
            media_type: 'POST',
          });
        }
      }
      if (byId.size >= limit) {
        break;
      }
    }

    const posts = [...byId.values()]
      .sort((a, b) => {
        const aTime = a.created_time ? Date.parse(a.created_time) : 0;
        const bTime = b.created_time ? Date.parse(b.created_time) : 0;
        return bTime - aTime;
      })
      .slice(0, limit);

    return { posts, errors };
  }

  async fetchInstagramPosts(
    instagramAccountId: string,
    pageAccessToken: string,
    limit = 20,
  ): Promise<MetaSocialPost[]> {
    type MediaRow = {
      id?: string;
      caption?: string;
      media_type?: string;
      media_url?: string;
      thumbnail_url?: string;
      permalink?: string;
      timestamp?: string;
      children?: { data?: Array<{ media_url?: string; media_type?: string }> };
    };

    const response = await this.graphGet<{ data?: MediaRow[] }>(
      `/${instagramAccountId}/media`,
      pageAccessToken,
      {
        fields:
          'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_url,media_type}',
        limit: String(limit),
      },
    );

    return (response.data ?? []).map((media) => ({
      id: String(media.id ?? ''),
      platform: 'instagram' as const,
      message: media.caption?.trim() ?? '',
      image_urls: this.extractInstagramImages(media),
      permalink: media.permalink ?? null,
      created_time: media.timestamp ?? null,
      media_type: media.media_type ?? null,
    }));
  }

  private extractFacebookImages(post: {
    full_picture?: string;
    attachments?: {
      data?: Array<{
        media?: { image?: { src?: string } };
        subattachments?: {
          data?: Array<{ media?: { image?: { src?: string } } }>;
        };
      }>;
    };
  }): string[] {
    const urls = new Set<string>();
    if (post.full_picture) {
      urls.add(post.full_picture);
    }
    for (const attachment of post.attachments?.data ?? []) {
      const main = attachment.media?.image?.src;
      if (main) {
        urls.add(main);
      }
      for (const child of attachment.subattachments?.data ?? []) {
        const childUrl = child.media?.image?.src;
        if (childUrl) {
          urls.add(childUrl);
        }
      }
    }
    return [...urls];
  }

  private extractInstagramImages(media: {
    media_type?: string;
    media_url?: string;
    thumbnail_url?: string;
    children?: { data?: Array<{ media_url?: string; media_type?: string }> };
  }): string[] {
    const urls = new Set<string>();
    if (media.media_type === 'VIDEO') {
      if (media.thumbnail_url) {
        urls.add(media.thumbnail_url);
      }
    } else if (media.media_url) {
      urls.add(media.media_url);
    }
    for (const child of media.children?.data ?? []) {
      if (child.media_type !== 'VIDEO' && child.media_url) {
        urls.add(child.media_url);
      }
    }
    return [...urls];
  }

  /**
   * Registers the WhatsApp number for the Cloud API (required after Embedded Signup before it can send
   * or receive). An already registered number (or a coexistence number) is treated as success.
   */
  async registerWhatsappNumber(phoneNumberId: string, accessToken: string, pin: string): Promise<{ registered: boolean; message: string }> {
    const cfg = this.getConfig();
    const response = await fetch(this.graphUrl(`/${encodeURIComponent(phoneNumberId)}/register`, cfg), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const payload = (await response.json().catch(() => ({}))) as { success?: boolean } & GraphErrorBody;
    if (response.ok && payload.success === true) return { registered: true, message: 'Number registered for the Cloud API.' };
    const message = payload.error?.message ?? `Meta answered ${response.status}`;
    if (/already registered|already been registered/i.test(message)) return { registered: true, message: 'Number was already registered.' };
    return { registered: false, message };
  }

  /** Small GET helper for the connection health check (returns null on any error). */
  async healthGet<T>(path: string, token: string, params: Record<string, string> = {}): Promise<{ ok: boolean; data: T | null; error: string | null }> {
    try {
      const cfg = this.getConfig();
      const query = new URLSearchParams(params).toString();
      const response = await fetch(`${this.graphUrl(path, cfg)}${query ? `?${query}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000),
      });
      const payload = (await response.json().catch(() => ({}))) as T & GraphErrorBody;
      return response.ok ? { ok: true, data: payload, error: null } : { ok: false, data: null, error: payload.error?.message ?? `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Embedded Signup fallback: the business token's granular scopes list the shared WhatsApp Business Accounts;
   * returns the first phone number found (the one the customer just set up in most cases).
   */
  async discoverSharedWhatsappNumber(accessToken: string): Promise<{ waba_id: string; phone_number_id: string } | null> {
    const cfg = this.getConfig();
    const appToken = `${cfg.appId}|${cfg.appSecret}`;
    const debug = await this.healthGet<{ data?: { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> } }>(
      '/debug_token', appToken, { input_token: accessToken });
    const wabaIds = Array.from(new Set((debug.data?.data?.granular_scopes ?? [])
      .filter((s) => s.scope === 'whatsapp_business_management' || s.scope === 'whatsapp_business_messaging')
      .flatMap((s) => s.target_ids ?? [])));
    for (const wabaId of wabaIds) {
      const numbers = await this.healthGet<{ data?: Array<{ id: string }> }>(`/${wabaId}/phone_numbers`, accessToken, { fields: 'id,display_phone_number,verified_name' });
      const first = numbers.data?.data?.[0];
      if (first?.id) return { waba_id: wabaId, phone_number_id: first.id };
    }
    return null;
  }
}
