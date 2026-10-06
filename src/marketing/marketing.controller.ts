import { FeatureGuard, RequiresFeature } from '../platform/feature.guard';
import { Body, Controller, Delete, Get, Header, Module, Param, ParseIntPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../bot-admin/entities/bot-message.entity';
import { CampaignsService, CHANNELS } from './campaigns.service';
import { MarketingService } from './marketing.service';

const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];

class AudienceDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) exclude_tags?: string[];
  @IsOptional() @IsIn(['', ...STAGES]) stage?: string;
}

class DaysDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) days?: number;
}

class AdAccountDto {
  @IsString() @Matches(/^act_\d+$/) ad_account_id: string;
}

class CampaignStatusDto {
  @IsIn(['ACTIVE', 'PAUSED']) status: 'ACTIVE' | 'PAUSED';
}

class CampaignBudgetDto {
  @Type(() => Number) @IsNumber() @Min(1) daily_budget: number;
}

class CapiDto {
  @IsOptional() @IsString() @MaxLength(40) dataset_id?: string;
  @IsOptional() @IsString() @MaxLength(1000) capi_token?: string;
  @IsOptional() @IsBoolean() capi_enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(40) capi_test_code?: string;
}

class BroadcastDto {
  @IsString() @MinLength(2) @MaxLength(255) name: string;
  @IsString() @MaxLength(255) template_name: string;
  @IsString() @MaxLength(20) template_language: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(500, { each: true }) body_params?: string[];
  @IsOptional() @ValidateNested() @Type(() => AudienceDto) audience?: AudienceDto;
  @IsOptional() @IsString() scheduled_at?: string | null;
  @IsOptional() @IsBoolean() send_now?: boolean;
  /** replies within 7 days are linked to this campaign (the AI answers about it) */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Number) @IsInt() campaign_id?: number | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class CampaignDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @IsIn(['active', 'paused', 'ended']) status?: 'active' | 'paused' | 'ended';
  @IsOptional() @ValidateIf((_o, v) => v !== null && v !== '') @Matches(DATE, { message: 'starts_at must look like 2026-12-31' }) starts_at?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null && v !== '') @Matches(DATE, { message: 'ends_at must look like 2026-12-31' }) ends_at?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) offer_text?: string;
  @IsOptional() @IsString() @MaxLength(1500) bot_instructions?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsInt({ each: true }) product_ids?: number[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(30, { each: true }) meta_campaign_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(30, { each: true }) meta_ad_ids?: string[];
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
}

class UpdateCampaignDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(['active', 'paused', 'ended']) status?: 'active' | 'paused' | 'ended';
  @IsOptional() @ValidateIf((_o, v) => v !== null && v !== '') @Matches(DATE, { message: 'starts_at must look like 2026-12-31' }) starts_at?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null && v !== '') @Matches(DATE, { message: 'ends_at must look like 2026-12-31' }) ends_at?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) offer_text?: string;
  @IsOptional() @IsString() @MaxLength(1500) bot_instructions?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsInt({ each: true }) product_ids?: number[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(30, { each: true }) meta_campaign_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(30, { each: true }) meta_ad_ids?: string[];
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
}

class LinkDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsIn(CHANNELS as unknown as string[]) channel: 'whatsapp' | 'messenger' | 'instagram';
  @IsString() @MinLength(2) @MaxLength(120) target: string;
  @IsOptional() @IsString() @MaxLength(450) prefill_text?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Number) @IsInt() campaign_id?: number | null;
  @IsOptional() @IsString() @MaxLength(32) slug?: string;
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
}

class UpdateLinkDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(CHANNELS as unknown as string[]) channel?: 'whatsapp' | 'messenger' | 'instagram';
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) target?: string;
  @IsOptional() @IsString() @MaxLength(450) prefill_text?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Number) @IsInt() campaign_id?: number | null;
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

class ScheduleDto {
  @IsOptional() @IsString() scheduled_at?: string | null;
}

class OptOutDto {
  @Type(() => Number) @IsInt() contact_id: number;
  @IsBoolean() opted_out: boolean;
}

class CreateAudienceDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @ValidateNested() @Type(() => AudienceDto) filters?: AudienceDto;
}

@Controller('marketing')
@ApiTags('Marketing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@AdminOnly()
export class MarketingController {
  constructor(private readonly marketing: MarketingService, private readonly campaignsService: CampaignsService) {}

  /* settings / Meta ads connection */
  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser) { return this.marketing.publicSettings(user); }

  @Get('meta/connect-url')
  @RequiresFeature('marketing_pro')
  connectUrl(@CurrentUser() user: AuthenticatedUser) { return this.marketing.connectUrl(user); }

  @Get('meta/ad-accounts')
  @RequiresFeature('marketing_pro')
  adAccounts(@CurrentUser() user: AuthenticatedUser) { return this.marketing.adAccounts(user); }

  @Post('meta/ad-account')
  @RequiresFeature('marketing_pro')
  chooseAdAccount(@CurrentUser() user: AuthenticatedUser, @Body() dto: AdAccountDto) { return this.marketing.chooseAdAccount(user, dto.ad_account_id); }

  @Post('meta/disconnect')
  disconnect(@CurrentUser() user: AuthenticatedUser) { return this.marketing.disconnect(user); }

  /* 1) ad tracking */
  @Get('attribution')
  @RequiresFeature('marketing_ads')
  attribution(@CurrentUser() user: AuthenticatedUser, @Query() query: DaysDto) { return this.marketing.attribution(user, query.days); }

  /* 2) + 3) campaigns */
  @Get('campaigns')
  @RequiresFeature('marketing_pro')
  campaigns(@CurrentUser() user: AuthenticatedUser, @Query() query: DaysDto) { return this.marketing.campaigns(user, query.days); }

  @Post('campaigns/:id/status')
  @RequiresFeature('marketing_pro')
  campaignStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CampaignStatusDto) { return this.marketing.setCampaignStatus(user, id, dto.status); }

  @Post('campaigns/:id/budget')
  @RequiresFeature('marketing_pro')
  campaignBudget(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CampaignBudgetDto) { return this.marketing.setCampaignBudget(user, id, dto.daily_budget); }

  /* 4) Conversions API */
  @Patch('capi')
  @RequiresFeature('marketing_pro')
  capi(@CurrentUser() user: AuthenticatedUser, @Body() dto: CapiDto) { return this.marketing.saveCapi(user, dto); }

  @Get('capi/events')
  @RequiresFeature('marketing_pro')
  capiEvents(@CurrentUser() user: AuthenticatedUser) { return this.marketing.capiLog(user); }

  /* 5) broadcasts */
  @Get('templates')
  @RequiresFeature('broadcasts')
  templates(@CurrentUser() user: AuthenticatedUser) { return this.marketing.templates(user); }

  @Post('audience-preview')
  @RequiresFeature('broadcasts')
  audiencePreview(@CurrentUser() user: AuthenticatedUser, @Body() dto: AudienceDto) { return this.marketing.audiencePreview(user, dto); }

  @Get('broadcasts')
  @RequiresFeature('broadcasts')
  broadcasts(@CurrentUser() user: AuthenticatedUser) { return this.marketing.broadcasts(user); }

  @Post('broadcasts')
  @RequiresFeature('broadcasts')
  createBroadcast(@CurrentUser() user: AuthenticatedUser, @Body() dto: BroadcastDto) { return this.marketing.createBroadcast(user, dto); }

  @Get('broadcasts/:id')
  @RequiresFeature('broadcasts')
  broadcast(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.marketing.broadcast(user, id); }

  @Post('broadcasts/:id/schedule')
  @RequiresFeature('broadcasts')
  schedule(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ScheduleDto) { return this.marketing.scheduleBroadcast(user, id, dto.scheduled_at ?? null); }

  @Post('broadcasts/:id/cancel')
  @RequiresFeature('broadcasts')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.marketing.cancelBroadcast(user, id); }

  @Post('optouts')
  @RequiresFeature('broadcasts')
  optOut(@CurrentUser() user: AuthenticatedUser, @Body() dto: OptOutDto) { return this.marketing.setOptOut(user, dto.contact_id, dto.opted_out); }

  /* campaigns (ads + short links + broadcasts, with what the AI should say) */
  @Get('chat-campaigns')
  @RequiresFeature('campaigns')
  campaignList(@CurrentUser() user: AuthenticatedUser, @Query() query: DaysDto) { return this.campaignsService.campaigns(user, query.days); }

  @Post('chat-campaigns')
  @RequiresFeature('campaigns')
  createCampaign(@CurrentUser() user: AuthenticatedUser, @Body() dto: CampaignDto) { return this.campaignsService.createCampaign(user, dto); }

  @Patch('chat-campaigns/:id')
  @RequiresFeature('campaigns')
  updateCampaign(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCampaignDto) { return this.campaignsService.updateCampaign(user, id, dto); }

  @Delete('chat-campaigns/:id')
  @RequiresFeature('campaigns')
  deleteCampaign(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.campaignsService.deleteCampaign(user, id); }

  @Get('chat-campaigns/:id/chats')
  @RequiresFeature('campaigns')
  campaignChats(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.campaignsService.campaignChats(user, id); }

  /* short links + QR codes */
  @Get('links')
  @RequiresFeature('campaigns')
  links(@CurrentUser() user: AuthenticatedUser, @Query() query: DaysDto) { return this.campaignsService.links(user, query.days); }

  @Get('links/defaults')
  @RequiresFeature('campaigns')
  linkDefaults(@CurrentUser() user: AuthenticatedUser) { return this.campaignsService.linkDefaults(user); }

  @Post('links')
  @RequiresFeature('campaigns')
  createLink(@CurrentUser() user: AuthenticatedUser, @Body() dto: LinkDto) { return this.campaignsService.createLink(user, dto); }

  @Patch('links/:id')
  @RequiresFeature('campaigns')
  updateLink(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLinkDto) { return this.campaignsService.updateLink(user, id, dto); }

  @Delete('links/:id')
  @RequiresFeature('campaigns')
  deleteLink(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.campaignsService.deleteLink(user, id); }

  @Get('links/:id/clicks')
  @RequiresFeature('campaigns')
  linkClicks(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.campaignsService.linkClicks(user, id); }

  /* 6) audiences */
  @Get('audiences')
  @RequiresFeature('marketing_pro')
  audiences(@CurrentUser() user: AuthenticatedUser) { return this.marketing.audiences(user); }

  @Post('audiences')
  @RequiresFeature('marketing_pro')
  createAudience(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAudienceDto) { return this.marketing.createAudience(user, dto); }
}

/** Meta sends the browser back here after "Connect ad account" (no login – checked by the signed state). */
@Controller('public/marketing/meta')
@ApiTags('Public')
export class MarketingCallbackController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    res.redirect(await this.marketing.oauthCallback(code, state));
  }
}

/** Public short links: https://<api>/l/<slug> → WhatsApp / Messenger / Instagram chat (outside /v1/api). */
@Controller('l')
@ApiTags('Public')
export class ShortLinkController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get(':slug')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex')
  async open(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    const target = await this.campaignsService.open(slug, { ip: req.ip, userAgent: req.get('user-agent') ?? undefined, referer: req.get('referer') ?? undefined });
    if (!target) {
      res.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not active</title><body style="font-family:system-ui;padding:40px;text-align:center"><h1>This link is not active</h1><p>Please contact the shop directly.</p></body>');
      return;
    }
    res.redirect(302, target);
  }
}

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([BotConversation, BotMessage])],
  controllers: [MarketingController, MarketingCallbackController, ShortLinkController],
  providers: [MarketingService, CampaignsService],
})
export class MarketingModule {}
