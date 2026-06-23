import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { WhatsappService } from './whatsapp.service';

function resolveApiBaseUrl(req: Request): string {
  const configured = (
    process.env.PUBLIC_API_BASE_URL ??
    process.env.API_PUBLIC_BASE_URL ??
    ''
  ).trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? 'http')
    .split(',')[0]
    .trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
    .split(',')[0]
    .trim();
  if (!host) {
    return 'http://localhost:3001/v1/api';
  }
  return `${forwardedProto}://${host}/v1/api`.replace(/\/+$/, '');
}

@Controller('integrations/whatsapp')
@ApiTags('WhatsApp Providers')
export class WhatsappWebhookController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get('config')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async getCompanyWhatsappConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const channel = await this.whatsappService.getChannelForCompany(
      user.company_id,
    );
    const webhooks = this.whatsappService.getPublicWebhookUrls(
      resolveApiBaseUrl(req),
    );
    return {
      provider_type: channel?.provider_type ?? 'evolution',
      ...webhooks,
      meta_phone_number_id: channel?.meta_phone_number_id ?? null,
      meta_waba_id: channel?.meta_waba_id ?? null,
      meta_verify_token: channel?.meta_verify_token ?? null,
      has_meta_access_token: Boolean(channel?.meta_access_token?.trim()),
      whatsapp_status: channel?.status ?? null,
    };
  }

  @Get('webhook/meta')
  @RawResponse()
  async verifyMetaWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const valid = await this.whatsappService.verifyMetaWebhookToken(verifyToken);
    if (mode === 'subscribe' && valid) {
      return challenge;
    }
    return 'Forbidden';
  }

  @Post('webhook/meta')
  @RawResponse()
  async handleMetaWebhook(@Body() body: unknown) {
    const result = await this.whatsappService.processInboundWebhook(body);
    return { ok: true, ...result };
  }

  @Post('webhook/evolution')
  @RawResponse()
  async handleEvolutionWebhook(@Body() body: unknown) {
    const result = await this.whatsappService.processInboundWebhook(body);
    return { ok: true, ...result };
  }

  @Post('webhook')
  @RawResponse()
  async handleUnifiedWebhook(@Body() body: unknown) {
    const result = await this.whatsappService.processInboundWebhook(body);
    return { ok: true, ...result };
  }
}
