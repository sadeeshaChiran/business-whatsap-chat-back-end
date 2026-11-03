import {
  Body, Controller, ForbiddenException, Get, Headers, HttpCode, Logger, Module, Param, ParseIntPipe, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../auth/auth.module';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AdminOnly } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { BotChannelUser } from '../../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../../bot-admin/entities/bot-message.entity';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { FeatureGuard, RequiresFeature } from '../../platform/feature.guard';
import { SalesBotModule } from '../../sales-bot/sales-bot.module';
import { verifyTiktokSignature } from './tiktok-api';
import { TiktokService, type TiktokEvent } from './tiktok.service';

/** Channels → TikTok (signed in): connect, status, check, disconnect, and the reply window of one chat. */
@Controller('integrations/tiktok')
@ApiTags('TikTok')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequiresFeature('tiktok')
export class TiktokController {
  constructor(private readonly tiktok: TiktokService, @InjectDataSource() private readonly dataSource: DataSource) {}

  @Get('status') @AdminOnly()
  status(@CurrentUser() user: AuthenticatedUser) { return this.tiktok.status(Number(user.company_id)); }

  @Post('connect') @AdminOnly()
  connect(@CurrentUser() user: AuthenticatedUser) { return { url: this.tiktok.connectUrl(Number(user.company_id), Number(user.id)) }; }

  @Post('check') @AdminOnly()
  check(@CurrentUser() user: AuthenticatedUser) { return this.tiktok.check(Number(user.company_id)); }

  @Post('disconnect') @AdminOnly()
  disconnect(@CurrentUser() user: AuthenticatedUser) { return this.tiktok.disconnect(Number(user.company_id)); }

  /** For the inbox: hours left in the 48-hour window and messages left before the customer must write again. */
  @Get('window/:conversationId')
  async window(@CurrentUser() user: AuthenticatedUser, @Param('conversationId', ParseIntPipe) conversationId: number) {
    const [row] = await this.dataSource.query(`
      SELECT cu.external_user_id, cu.source_account_id, cu.company_id, c.assigned_agent_id FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
       WHERE c.id = $1 AND cu.platform = 'tiktok'`, [conversationId]);
    if (!row || Number(row.company_id) !== Number(user.company_id)) throw new ForbiddenException('Not a TikTok chat of your business.');
    return this.tiktok.window(Number(user.company_id), row.source_account_id, row.external_user_id);
  }
}

/** Public: TikTok's login redirect and the direct-message webhook. */
@Controller('integrations/tiktok')
export class TiktokPublicController {
  private readonly logger = new Logger('TiktokWebhook');
  constructor(private readonly tiktok: TiktokService) {}

  @Get('callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined,
    @Query('error') error: string | undefined, @Query('error_description') description: string | undefined, @Res() res: Response) {
    const back = (params: Record<string, string>) => res.redirect(this.tiktok.appUrl(`/channels/tiktok?${new URLSearchParams(params).toString()}`));
    if (error) return back({ error: description || error });
    if (!code || !state) return back({ error: 'TikTok did not send the login code. Try again.' });
    try {
      const done = await this.tiktok.completeConnect(code, state);
      return back({ connected: done.username ?? '1' });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.logger.warn(`TikTok connect failed: ${message}`);
      return back({ error: message.slice(0, 300) });
    }
  }

  @Post('webhook')
  @SkipThrottle()
  @HttpCode(200)
  @RawResponse()
  receive(@Body() body: TiktokEvent, @Req() request: Request & { rawBody?: Buffer }, @Headers('tiktok-signature') signature?: string) {
    if (!verifyTiktokSignature(signature, request.rawBody)) {
      this.logger.warn('TikTok webhook rejected: bad or old signature (check TIKTOK_APP_SECRET and the server clock)');
      throw new ForbiddenException('Invalid TikTok signature.');
    }
    // answer TikTok at once; an echo of our own reply waits a moment so the reply is saved first
    const delay = body?.event === 'im_send_msg' ? Number(process.env.TIKTOK_ECHO_DELAY_MS ?? 2000) : 0;
    setTimeout(() => {
      this.tiktok.handleEvent(body).catch((failure) => this.logger.error(`TikTok event failed: ${failure instanceof Error ? failure.message : String(failure)}`));
    }, delay);
    return { ok: true };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([BotChannelUser, BotConversation, BotMessage]), AuthModule, SalesBotModule],
  controllers: [TiktokController, TiktokPublicController],
  providers: [TiktokService],
  exports: [TiktokService],
})
export class TiktokModule {}
