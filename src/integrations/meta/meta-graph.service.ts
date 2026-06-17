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
  getConfig(): MetaGraphConfig {
    const appId = process.env.META_APP_ID?.trim() ?? '';
    const appSecret = process.env.META_APP_SECRET?.trim() ?? '';
    const redirectUri = process.env.META_OAUTH_REDIRECT_URI?.trim() ?? '';
    const graphVersion =
      process.env.META_GRAPH_API_VERSION?.trim() || 'v19.0';
    const scopes =
      process.env.META_OAUTH_SCOPES?.trim() ||
      'pages_show_list,pages_read_engagement,instagram_business_basic';
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

  frontendSuccessRedirect(query = ''): string {
    const base =
      process.env.META_OAUTH_SUCCESS_REDIRECT?.trim() ||
      'http://localhost:5173/settings';
    return query ? `${base}${base.includes('?') ? '&' : '?'}${query}` : base;
  }

  frontendErrorRedirect(message: string): string {
    const base = this.frontendSuccessRedirect();
    const params = new URLSearchParams({ meta: 'error', message });
    return `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
  }

  private graphUrl(path: string, cfg: MetaGraphConfig): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `https://graph.facebook.com/${cfg.graphVersion}${normalized}`;
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
}
