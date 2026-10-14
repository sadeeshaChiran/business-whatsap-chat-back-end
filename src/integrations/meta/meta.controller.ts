import { FeatureGuard, RequiresAnyFeature } from '../../platform/feature.guard';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CompanyService } from '../../company/company.service';
import { Company } from '../../company/entities/company.entity';
import { MetaPageConnection } from '../../meta/entities/meta-page-connection.entity';
import { MetaPageConnectionService } from '../../meta/meta-page-connection.service';
import { ConnectMetaPageDto } from './dto/connect-meta-page.dto';
import { ConnectWhatsappEmbeddedDto } from './dto/connect-whatsapp-embedded.dto';
import { WhatsappChannelService } from '../../whatsapp/whatsapp-channel.service';
import { randomBytes } from 'crypto';
import { APP_WEBHOOK_FIELDS, MetaGraphService, type MetaSocialPost } from './meta-graph.service';
import { buildMetaOAuthState } from './meta-oauth-state.util';
import { recentMetaEvents } from './webhook-events';
import { webhookCheck } from './webhook-stats';
import { tokenScopes } from '../../marketing/graph';

type HealthCheck = { key: string; label: string; ok: boolean | null; detail: string; fix?: string; tech?: boolean; tech_detail?: string };

/** Platform-side checks: shown under "Technical details", not in the shop owner's list. */
const TECH_KEYS = new Set(['public_url', 'provider', 'token_app', 'delivery', 'app_webhook', 'meta_events']);
const QUALITY: Record<string, string> = {
  GREEN: 'Good',
  YELLOW: 'Medium – avoid sending too many marketing messages',
  RED: 'Low – Meta may limit this number. Send fewer marketing messages.',
};

/** Plain words for the shop owner; the original wording stays for the technical list. */
/** What Meta actually sent lately (no message text) – shows whether ad clicks arrive at all. */
function eventsCheck(companyId: number | null | undefined, platform: 'messenger' | 'instagram') {
  const list = recentMetaEvents(Number(companyId ?? 0), platform);
  const ads = list.filter((e) => e.details.some((d) => d.startsWith('referral')));
  const replies = list.filter((e) => e.details.includes('reply to an earlier message'));
  const lines = list.slice(0, 12).map((e) => `${e.at.slice(11, 19)} UTC · ${e.kind}${e.details.length ? ` – ${e.details.join('; ')}` : ''}`);
  return {
    key: 'meta_events', label: 'What Meta sent lately (since the server started)', ok: null,
    detail: list.length
      ? `${list.length} events, ${ads.length} with ad / link details, ${replies.length} replies to a Page message.\n${lines.join('\n')}`
      : 'Nothing yet since the server started. Send a message to the Page (or click your ad), then press “Check again”.',
  };
}

export function presentChecks(checks: HealthCheck[], channel: 'whatsapp' | 'messenger' | 'instagram'): HealthCheck[] {
  return checks.map((raw) => {
    if (TECH_KEYS.has(raw.key)) return { ...raw, tech: true };
    const check = { ...raw, tech_detail: raw.detail };
    switch (check.key) {
      case 'token':
        return { ...check, label: channel === 'whatsapp' ? 'WhatsApp number connected' : 'Facebook Page connected',
          detail: check.ok ? check.detail : `Please connect again. Meta says: ${check.detail}` };
      case 'quality':
        return { ...check, label: 'Number health', detail: QUALITY[check.detail] ?? check.detail };
      case 'registered':
        return { ...check, label: 'Number can send and receive messages',
          detail: check.ok ? 'Ready' : 'Not ready yet. Press “Fix it” and enter your 6-digit WhatsApp PIN (or choose a new one).' };
      case 'webhook':
        return { ...check, label: 'New messages come to your Inbox',
          detail: check.ok ? 'On' : check.fix ? 'Off – press “Fix it”.' : `Off – ${check.detail}` };
      case 'linked':
        return { ...check, label: 'Instagram account linked', detail: check.ok ? 'Linked to your Facebook Page' : check.detail };
      case 'dm_access':
        return { ...check, label: 'Instagram setting “Allow access to messages”',
          detail: 'Make sure it is on: Instagram app → Settings → Messages and story replies → Connected tools.' };
      default:
        return check;
    }
  });
}

@Controller('integrations/meta')
@ApiTags('Integrations - Meta')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class MetaController {
  constructor(
    private readonly metaGraphService: MetaGraphService,
    private readonly metaPageConnectionService: MetaPageConnectionService,
    private readonly companyService: CompanyService,
    private readonly whatsappChannelService: WhatsappChannelService,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(MetaPageConnection)
    private readonly metaPageConnectionRepository: Repository<MetaPageConnection>,
  ) {}

  private async assertAdmin(user: AuthenticatedUser) {
    const company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });
    if (!company || Number(company.admin_user_id) !== Number(user.id)) {
      throw new ForbiddenException('Only the company admin can manage Facebook Page connections.');
    }
    return company;
  }

  private async syncInstagramLink(
    connection: MetaPageConnection,
  ): Promise<MetaPageConnection> {
    const refreshed = await this.metaGraphService.refreshInstagramAccount(
      connection.page_id,
      connection.page_access_token,
    );
    if (
      refreshed.id &&
      refreshed.id !== connection.instagram_business_account_id
    ) {
      return (
        (await this.metaPageConnectionService.patchInstagramAccount(
          connection.company_id,
          refreshed.id,
        )) ?? connection
      );
    }
    return connection;
  }

  @Get('whatsapp/config')
  async getWhatsappEmbeddedConfig(@CurrentUser() user: AuthenticatedUser) {
    await this.assertAdmin(user);
    return this.metaGraphService.getEmbeddedSignupConfig();
  }

  @Post('whatsapp/connect')
  async connectWhatsappEmbedded(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectWhatsappEmbeddedDto,
  ) {
    const company = await this.assertAdmin(user);
    const existing = await this.whatsappChannelService.getForCompany(user.company_id);
    if (body.phone_number_id) await this.companyService.assertWhatsappNumberFree(Number(company.id), body.phone_number_id.trim());

    const accessToken = await this.metaGraphService.exchangeEmbeddedSignupCode(body.code, body.page_url);
    // Meta's browser message can get lost (popup closed early, blockers): then find the shared account + number from the token
    let wabaId = body.waba_id?.trim() ?? '';
    let phoneNumberId = body.phone_number_id?.trim() ?? '';
    if (!wabaId || !phoneNumberId) {
      const found = await this.metaGraphService.discoverSharedWhatsappNumber(accessToken);
      if (!found) throw new BadRequestException('Meta did not share a WhatsApp number. Run the setup again and choose (or add) a phone number.');
      wabaId = found.waba_id;
      phoneNumberId = found.phone_number_id;
      await this.companyService.assertWhatsappNumberFree(Number(company.id), phoneNumberId);
    }
    const replaced = existing?.meta_phone_number_id && existing.meta_phone_number_id !== phoneNumberId ? existing.meta_phone_number_id : null;
    const phone = await this.metaGraphService.fetchWhatsappPhoneNumber(phoneNumberId, accessToken);
    await this.metaGraphService.subscribeWhatsappApp(wabaId, accessToken);
    // Cloud API numbers must be registered before they can send / receive (6-digit two-step PIN)
    const pin = /^\d{6}$/.test(String(process.env.WHATSAPP_REGISTRATION_PIN ?? '')) ? String(process.env.WHATSAPP_REGISTRATION_PIN) : String(Math.floor(100000 + Math.random() * 900000));
    const registration = await this.metaGraphService.registerWhatsappNumber(phoneNumberId, accessToken, pin);

    const verifyToken = existing?.meta_verify_token?.trim()
      || process.env.META_WEBHOOK_VERIFY_TOKEN?.trim()
      || randomBytes(24).toString('hex');
    const webhookBase = existing?.meta_webhook_base_url?.trim()
      || process.env.PUBLIC_API_BASE_URL?.trim()
      || process.env.API_BASE_URL?.trim()
      || '';
    const savedCompany = await this.companyService.update(Number(company.id), {
      phone: phone.display_phone_number.replace(/\D/g, ''),
      whatsapp_provider_type: 'meta',
      meta_phone_number_id: phoneNumberId,
      meta_waba_id: wabaId,
      meta_access_token: accessToken,
      meta_verify_token: verifyToken,
      meta_webhook_base_url: webhookBase,
    }, user);
    return {
      company: savedCompany,
      display_phone_number: phone.display_phone_number,
      verified_name: phone.verified_name,
      subscribed: true,
      registered: registration.registered,
      registration_message: registration.registered ? null : `The number could not be registered for the Cloud API: ${registration.message}`,
      replaced_previous_number: Boolean(replaced),
    };
  }
  /**
   * Connection health for the Channels screen: WhatsApp (token, number, webhook subscription, public URL),
   * Messenger (Page token, webhook subscription) and Instagram (linked account). Never changes anything.
   */
  @Get('health')
  async health(@CurrentUser() user: AuthenticatedUser) {
    await this.assertAdmin(user);
    type Check = HealthCheck;
    const publicBase = process.env.PUBLIC_API_BASE_URL?.trim() || '';
    const whatsapp: Check[] = [];
    const channel = await this.whatsappChannelService.getForCompany(user.company_id);
    const token = channel?.meta_access_token?.trim() || '';
    whatsapp.push({ key: 'public_url', label: 'Public API address (webhooks, media, invoices)', ok: Boolean(publicBase), detail: publicBase || 'Set PUBLIC_API_BASE_URL on the API server' });
    if ((channel?.provider_type ?? 'meta') !== 'meta') {
      whatsapp.push({ key: 'provider', label: 'Provider', ok: null, detail: `Uses ${channel?.provider_type} (not checked here)` });
    } else if (!channel?.meta_phone_number_id || !token) {
      whatsapp.push({ key: 'connected', label: 'WhatsApp number connected', ok: false, detail: 'Not connected yet – use "Connect WhatsApp".' });
    } else {
      const phone = await this.metaGraphService.healthGet<{ display_phone_number?: string; verified_name?: string; quality_rating?: string; code_verification_status?: string; platform_type?: string; status?: string }>(
        `/${channel.meta_phone_number_id}`, token, { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status' });
      whatsapp.push({ key: 'token', label: 'Access token works', ok: phone.ok, detail: phone.ok ? `${phone.data?.display_phone_number ?? ''} · ${phone.data?.verified_name ?? ''}` : phone.error ?? '' });
      const tokenInfo = await this.tokenCheck(token);
      if (tokenInfo) whatsapp.push(tokenInfo);
      if (phone.ok) {
        whatsapp.push({ key: 'quality', label: 'Number quality', ok: phone.data?.quality_rating !== 'RED', detail: phone.data?.quality_rating ?? 'unknown' });
        const registered = phone.data?.platform_type === 'CLOUD_API';
        whatsapp.push({
          key: 'registered', label: 'Number is registered for the Cloud API', ok: registered,
          detail: registered ? `Status: ${phone.data?.status ?? 'CONNECTED'}` : `Meta says: ${phone.data?.platform_type ?? 'not registered'} / ${phone.data?.status ?? '?'}. A number that is not registered cannot send or receive. Press “Fix it” and enter the 6-digit two-step PIN (or a new one if none was set).`,
          fix: registered ? undefined : 'whatsapp_register',
        });
      }
      if (channel.meta_waba_id) {
        const apps = await this.metaGraphService.healthGet<{ data?: Array<{ whatsapp_business_api_data?: { id?: string; name?: string } }> }>(`/${channel.meta_waba_id}/subscribed_apps`, token);
        const rows = apps.data?.data ?? [];
        const appId = process.env.META_APP_ID?.trim() ?? '';
        const ours = rows.some((row) => String(row.whatsapp_business_api_data?.id ?? '') === appId);
        const names = rows.map((row) => `${row.whatsapp_business_api_data?.name ?? 'app'} (${row.whatsapp_business_api_data?.id ?? '?'})`).join(', ');
        whatsapp.push({
          key: 'webhook', label: 'Messages are sent to Agent Metra (webhook)', ok: apps.ok && ours,
          detail: !apps.ok ? apps.error ?? '' : ours ? `This platform's Meta app is subscribed${rows.length > 1 ? ` (all: ${names})` : ''}` : rows.length ? `Subscribed: ${names} – not this platform's Meta app (${appId}). Press “Fix it”.` : 'No Meta app is subscribed to this WhatsApp Business Account. Press “Fix it”.',
          fix: apps.ok && !ours ? 'whatsapp_subscribe' : undefined,
        });
      }
      whatsapp.push({ key: 'delivery', label: 'Meta is calling the webhook', ...webhookCheck('whatsapp') });
      whatsapp.push({ key: 'app_webhook', label: 'Meta app: WhatsApp webhook verified, field “messages” subscribed', ok: null, detail: 'Meta Developers → your app → WhatsApp → Configuration → Webhook. Callback: .../integrations/whatsapp/webhook/meta' });
    }

    const messenger: Check[] = [];
    const instagram: Check[] = [];
    const page = await this.metaPageConnectionRepository.findOne({ where: { company_id: user.company_id, status: 'CONNECTED' }, order: { id: 'DESC' } });
    if (!page?.page_access_token) {
      messenger.push({ key: 'page', label: 'Facebook Page connected', ok: false, detail: 'Not connected yet – use "Connect with Facebook".' });
      instagram.push({ key: 'page', label: 'Facebook Page connected (Instagram needs it)', ok: false, detail: 'Connect the Facebook Page that is linked to your Instagram account.' });
    } else {
      const me = await this.metaGraphService.healthGet<{ name?: string }>(`/${page.page_id}`, page.page_access_token, { fields: 'name' });
      messenger.push({ key: 'token', label: 'Page token works', ok: me.ok, detail: me.ok ? me.data?.name ?? '' : me.error ?? '' });
      const subs = await this.metaGraphService.healthGet<{ data?: Array<{ id?: string; name?: string; subscribed_fields?: string[] }> }>(`/${page.page_id}/subscribed_apps`, page.page_access_token);
      const appId = process.env.META_APP_ID?.trim() ?? '';
      const rows = subs.data?.data ?? [];
      const ours = rows.find((row) => String(row.id ?? '') === appId);
      const others = rows.filter((row) => String(row.id ?? '') !== appId);
      const fields = ours?.subscribed_fields ?? [];
      const subscribed = subs.ok && fields.includes('messages');
      const otherText = others.length ? ` Other app(s) still subscribed: ${others.map((row) => `${row.name ?? 'app'} (${row.id})`).join(', ')} – remove them, or their messages are refused.` : '';
      messenger.push({
        key: 'webhook', label: 'Messages are sent to Agent Metra (webhook)', ok: subscribed,
        detail: !subs.ok ? subs.error ?? '' : subscribed ? `${fields.join(', ')}${otherText}` : `This platform's Meta app (${appId}) is not subscribed to the Page – press “Fix it”.${otherText}`,
        fix: subs.ok && !subscribed ? 'messenger_subscribe' : undefined,
      });
      if (subscribed) {
        const referrals = fields.includes('messaging_referrals');
        messenger.push({
          key: 'ad_clicks', label: 'Ad clicks are sent to Agent Metra (who came from which ad)', ok: referrals,
          detail: referrals ? 'Click-to-Messenger ads and "Send message" buttons are linked to the chat.' : 'The Page is not sending ad clicks ("messaging_referrals"), so chats from ads look like normal chats – press “Fix it”.',
          fix: referrals ? undefined : 'messenger_subscribe',
        });
      }
      messenger.push({ key: 'delivery', label: 'Meta is calling the webhook', ...webhookCheck('messenger') });
      const app = await this.metaGraphService.appWebhookFields();
      const missing = (object: 'page' | 'instagram') => APP_WEBHOOK_FIELDS[object].filter((f) => !(app.objects[object]?.fields ?? []).includes(f));
      const appCheck = (object: 'page' | 'instagram', label: string) => {
        if (!app.ok) return { key: 'app_webhook', label, ok: null, detail: `Could not read the Meta app webhooks (${app.error ?? 'unknown'}). Check Meta Developers → your app → Webhooks.` };
        const gone = missing(object);
        return {
          key: 'app_webhook', label, ok: gone.length === 0,
          detail: gone.length ? `Missing: ${gone.join(', ')} – press “Fix it” (adds them to the platform's Meta app).` : `Fields: ${APP_WEBHOOK_FIELDS[object].join(', ')}.`,
          fix: gone.length ? 'meta_app_webhooks' : undefined,
        };
      };
      messenger.push(appCheck('page', 'Meta app: Messenger webhook fields (messages, buttons, ad clicks, comments)'));
      messenger.push(eventsCheck(user.company_id, 'messenger'));
      messenger.push({ key: 'dev_mode', label: 'Meta app is Live', ok: null, detail: 'While the app is in Development mode, only people with a role on the app (admin / developer / tester) reach the Page.' });
      instagram.push({ key: 'page', label: 'Facebook Page connected', ok: true, detail: page.page_name ?? page.page_id });
      instagram.push({ key: 'linked', label: 'Instagram professional account linked to the Page', ok: Boolean(page.instagram_business_account_id),
        detail: page.instagram_business_account_id ? `Instagram account ${page.instagram_business_account_id}` : 'Link the Instagram account to this Facebook Page (Instagram → Settings → Linked accounts / Meta Business Suite).' });
      instagram.push({ key: 'dm_access', label: 'Instagram → Settings → Messages → "Allow access to messages" is on', ok: null, detail: 'Check this in the Instagram app (it cannot be read by Agent Metra).' });
      instagram.push(appCheck('instagram', 'Meta app: Instagram webhook fields (messages, buttons, ad clicks, comments)'));
      instagram.push(eventsCheck(user.company_id, 'instagram'));
    }
    return { whatsapp: presentChecks(whatsapp, 'whatsapp'), messenger: presentChecks(messenger, 'messenger'), instagram: presentChecks(instagram, 'instagram') };
  }

  /** Who made this access token, and does it expire? (debug_token with the app token) */
  private async tokenCheck(token: string): Promise<{ key: string; label: string; ok: boolean | null; detail: string } | null> {
    const appId = process.env.META_APP_ID?.trim();
    const secret = process.env.META_APP_SECRET?.trim();
    if (!appId || !secret) return null;
    const debug = await this.metaGraphService.healthGet<{ data?: { app_id?: string; is_valid?: boolean; expires_at?: number; scopes?: string[] } }>('/debug_token', `${appId}|${secret}`, { input_token: token });
    const data = debug.data?.data;
    if (!debug.ok || !data) return { key: 'token_app', label: 'Token belongs to this platform\'s Meta app', ok: false, detail: `${debug.error ?? 'Meta could not read the token'} – the token was probably made in another Meta app. Create a System User token in the new app and save it again.` };
    const problems: string[] = [];
    if (String(data.app_id ?? '') !== appId) problems.push(`made for Meta app ${data.app_id ?? '?'}, but the server uses ${appId}`);
    if (data.is_valid === false) problems.push('not valid any more');
    const scopes = data.scopes ?? [];
    for (const scope of ['whatsapp_business_messaging', 'whatsapp_business_management']) if (!scopes.includes(scope)) problems.push(`missing ${scope}`);
    const expires = Number(data.expires_at ?? 0);
    if (expires > 0) problems.push(`expires ${new Date(expires * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC – use a permanent System User token`);
    return { key: 'token_app', label: 'Token is permanent and belongs to this platform\'s Meta app', ok: problems.length === 0, detail: problems.length ? `Token ${problems.join('; ')}.` : 'Permanent token with WhatsApp permissions.' };
  }

  /** "Fix it" buttons of the connection check. */
  @Post('health/fix')
  async fixHealth(@CurrentUser() user: AuthenticatedUser, @Body() body: { action?: string; pin?: string }) {
    await this.assertAdmin(user);
    const action = String(body?.action ?? '');
    if (action === 'whatsapp_subscribe' || action === 'whatsapp_register') {
      const channel = await this.whatsappChannelService.getForCompany(user.company_id);
      const token = channel?.meta_access_token?.trim();
      if (!token || !channel?.meta_phone_number_id) throw new BadRequestException('Connect a WhatsApp number first.');
      if (action === 'whatsapp_subscribe') {
        if (!channel.meta_waba_id) throw new BadRequestException('Enter the WhatsApp Business Account ID first.');
        await this.metaGraphService.subscribeWhatsappApp(channel.meta_waba_id, token);
        return { ok: true, message: 'Messages for this WhatsApp number now go to Agent Metra.' };
      }
      const pin = String(body?.pin ?? '').trim();
      if (!/^\d{6}$/.test(pin)) throw new BadRequestException('Enter a 6-digit PIN.');
      const result = await this.metaGraphService.registerWhatsappNumber(channel.meta_phone_number_id, token, pin);
      if (!result.registered) throw new BadRequestException(`Meta: ${result.message}`);
      return { ok: true, message: result.message };
    }
    if (action === 'meta_app_webhooks') {
      const result = await this.metaGraphService.fixAppWebhookFields();
      return { ok: true, message: result.changed.length ? `Added to the Meta app: ${result.changed.join('; ')}.` : 'The Meta app already has every webhook field.' };
    }
    if (action === 'messenger_subscribe') {
      const page = await this.metaPageConnectionRepository.findOne({ where: { company_id: user.company_id, status: 'CONNECTED' }, order: { id: 'DESC' } });
      if (!page?.page_access_token) throw new BadRequestException('Connect a Facebook Page first.');
      await this.metaGraphService.subscribePageMessaging(page.page_id, page.page_access_token);
      return { ok: true, message: 'Page messages and ad clicks now go to Agent Metra.' };
    }
    throw new BadRequestException('Unknown fix.');
  }

  @Get('auth-url')
  @UseGuards(FeatureGuard)
  @RequiresAnyFeature('messenger', 'instagram')
  async getAuthUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Query('return_path') returnPath?: string,
  ) {
    await this.assertAdmin(user);
    const state = buildMetaOAuthState(user.company_id, user.id, returnPath);
    return {
      url: this.metaGraphService.buildAuthUrl(state),
    };
  }

  @Get('pending-pages')
  @UseGuards(FeatureGuard)
  @RequiresAnyFeature('messenger', 'instagram')
  async listPendingPages(@CurrentUser() user: AuthenticatedUser) {
    await this.assertAdmin(user);
    const pages = await this.metaPageConnectionService.listPendingPageChoices(
      user.company_id,
    );
    return { pages };
  }

  @Post('connect')
  @UseGuards(FeatureGuard)
  @RequiresAnyFeature('messenger', 'instagram')
  async connectPage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectMetaPageDto,
  ) {
    const company = await this.assertAdmin(user);
    const cfg = this.metaGraphService.getConfig();
    let connection = await this.metaPageConnectionService.connectPage(
      user.company_id,
      company.name,
      body.page_id.trim(),
      cfg.scopes,
    );
    // save what Meta really granted (with a login configuration the server's scope list is not what was asked for)
    const granted = await tokenScopes(connection.page_access_token);
    if (granted?.length) {
      await this.metaPageConnectionRepository.update({ id: connection.id } as never, { scopes: granted.join(',') } as never);
      connection.scopes = granted.join(',');
    }
    connection = await this.syncInstagramLink(connection);
    // Turn on the Messenger / Instagram message webhook for this Page. A failure must not block
    // connecting the Page (it is still usable for posts); it is shown as a warning instead.
    let messagingWarning: string | null = null;
    try {
      await this.metaGraphService.subscribePageMessaging(connection.page_id, connection.page_access_token);
    } catch (error) {
      messagingWarning = error instanceof Error ? error.message : String(error);
      await this.metaPageConnectionRepository.update({ id: connection.id }, { last_error: `Messaging webhook: ${messagingWarning}` });
    }
    const savedCompany = await this.companyService.findOne(
      user.company_id,
      user,
    );
    return { company: savedCompany, connection, messaging_warning: messagingWarning };
  }

  @Delete('connection')
  async disconnect(@CurrentUser() user: AuthenticatedUser) {
    await this.assertAdmin(user);
    await this.metaPageConnectionService.disconnect(user.company_id);
    const savedCompany = await this.companyService.findOne(
      user.company_id,
      user,
    );
    return { company: savedCompany };
  }

  @Get('posts')
  async listPosts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('platform') platform?: string,
    @Query('limit') limit?: string,
  ) {
    await this.assertAdmin(user);
    let connection = await this.metaPageConnectionService.requireConnected(
      user.company_id,
    );
    connection = await this.syncInstagramLink(connection);

    const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const normalizedPlatform = (platform ?? 'all').trim().toLowerCase();

    const posts: MetaSocialPost[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let facebookCount = 0;
    let instagramCount = 0;

    if (normalizedPlatform === 'all' || normalizedPlatform === 'facebook') {
      try {
        const facebookResult = await this.metaGraphService.fetchFacebookPosts(
          connection.page_id,
          connection.page_access_token,
          parsedLimit,
        );
        facebookCount = facebookResult.posts.length;
        posts.push(...facebookResult.posts);
        if (facebookResult.errors.length) {
          const permissionHint = facebookResult.errors.some((item) =>
            /permission|pages_read_engagement|OAuthException|200/i.test(item),
          );
          if (permissionHint) {
            errors.push(
              'Meta denied Page post access. Add pages_read_engagement to your Facebook Login for Business configuration, reconnect the Page, and submit App Review if the app is Live.',
            );
          }
          warnings.push(...facebookResult.errors.slice(0, 3));
        }
        if (!facebookResult.posts.length) {
          warnings.push(
            'No Facebook posts or photos returned from Graph API. If your Page has photos (e.g. facebook.com/photo?fbid=...), reconnect after granting pages_read_engagement in Meta app settings.',
          );
        }
      } catch (error) {
        const message =
          error instanceof BadRequestException
            ? String(error.message)
            : error instanceof Error
              ? error.message
              : 'Facebook posts request failed.';
        errors.push(message);
      }
    }

    const instagramLinked = Boolean(connection.instagram_business_account_id);
    if (
      !instagramLinked &&
      (normalizedPlatform === 'instagram' || normalizedPlatform === 'all')
    ) {
      warnings.push(
        'Instagram is not linked to this Facebook Page. Link a Professional Instagram account in Meta Business Suite, then click Load posts again.',
      );
    }
    if (
      instagramLinked &&
      (normalizedPlatform === 'all' || normalizedPlatform === 'instagram')
    ) {
      try {
        const instagramPosts = await this.metaGraphService.fetchInstagramPosts(
          connection.instagram_business_account_id as string,
          connection.page_access_token,
          parsedLimit,
        );
        instagramCount = instagramPosts.length;
        posts.push(...instagramPosts);
        if (!instagramPosts.length) {
          warnings.push(
            'No Instagram posts returned. Post on Instagram or check that the instagram_basic permission was granted (reconnect the Page).',
          );
        }
      } catch (error) {
        const message =
          error instanceof BadRequestException
            ? String(error.message)
            : error instanceof Error
              ? error.message
              : 'Instagram posts request failed.';
        errors.push(message);
      }
    }

    posts.sort((a, b) => {
      const aTime = a.created_time ? Date.parse(a.created_time) : 0;
      const bTime = b.created_time ? Date.parse(b.created_time) : 0;
      return bTime - aTime;
    });

    await this.metaPageConnectionRepository.save({
      ...connection,
      last_synced_at: new Date(),
      last_error: errors.length ? errors.join(' | ') : null,
      updated_at: new Date(),
    });

    return {
      page_id: connection.page_id,
      page_name: connection.page_name,
      instagram_business_account_id: connection.instagram_business_account_id,
      instagram_linked: instagramLinked,
      facebook_count: facebookCount,
      instagram_count: instagramCount,
      warnings,
      errors,
      posts: posts.slice(0, parsedLimit),
    };
  }
}
