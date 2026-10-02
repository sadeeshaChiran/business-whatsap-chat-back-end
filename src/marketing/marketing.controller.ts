import { FeatureGuard, RequiresFeature } from '../platform/feature.guard';
import { Body, Controller, Get, Module, Param, ParseIntPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../bot-admin/entities/bot-message.entity';
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
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

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

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([BotConversation, BotMessage])],
  controllers: [MarketingController, MarketingCallbackController],
  providers: [MarketingService],
})
export class MarketingModule {}
