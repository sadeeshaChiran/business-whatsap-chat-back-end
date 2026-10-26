import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Logger, Module, Param, ParseIntPipe, Post, Put, Query, UploadedFile,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
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
import { TelegramService, type TelegramUpdate } from './telegram.service';

const tagList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : String(value ?? '').split(',')).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
const yes = (value: unknown) => value === true || value === 'true' || value === '1' || value === 1;

/** Channels → Telegram (owner): connect the bot, link a channel, announcements. */
@Controller('integrations/telegram')
@ApiTags('Telegram')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequiresFeature('telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Get('status') @AdminOnly()
  status(@CurrentUser() user: AuthenticatedUser) { return this.telegram.status(Number(user.company_id)); }

  @Post('connect') @AdminOnly()
  connect(@CurrentUser() user: AuthenticatedUser, @Body() body: { token?: string }) {
    return this.telegram.connect(Number(user.company_id), Number(user.id), String(body?.token ?? ''));
  }

  @Post('check') @AdminOnly()
  check(@CurrentUser() user: AuthenticatedUser) { return this.telegram.check(Number(user.company_id)); }

  @Post('disconnect') @AdminOnly()
  disconnect(@CurrentUser() user: AuthenticatedUser) { return this.telegram.disconnect(Number(user.company_id)); }

  @Put('settings') @AdminOnly()
  settings(@CurrentUser() user: AuthenticatedUser, @Body() body: { welcome_text?: string | null }) {
    return this.telegram.saveSettings(Number(user.company_id), { welcome_text: body?.welcome_text ?? null });
  }

  @Post('channel') @AdminOnly()
  linkChannel(@CurrentUser() user: AuthenticatedUser, @Body() body: { channel?: string }) {
    return this.telegram.linkChannel(Number(user.company_id), String(body?.channel ?? ''));
  }

  @Delete('channel') @AdminOnly()
  unlinkChannel(@CurrentUser() user: AuthenticatedUser) { return this.telegram.unlinkChannel(Number(user.company_id)); }

  @Get('audience') @AdminOnly()
  audience(@CurrentUser() user: AuthenticatedUser, @Query('tags') tags?: string) {
    return this.telegram.audience(Number(user.company_id), tagList(tags));
  }

  @Get('announcements') @AdminOnly()
  announcements(@CurrentUser() user: AuthenticatedUser) { return this.telegram.announcements(Number(user.company_id)); }

  @Post('announcements') @AdminOnly()
  @UseInterceptors(FileInterceptor('photo', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  announce(@CurrentUser() user: AuthenticatedUser, @Body() body: Record<string, unknown>,
    @UploadedFile() photo?: { buffer: Buffer; mimetype: string; originalname: string }) {
    return this.telegram.announce(Number(user.company_id), Number(user.id), {
      text: String(body?.text ?? ''), to_channel: yes(body?.to_channel), to_subscribers: yes(body?.to_subscribers), tags: tagList(body?.tags),
      photo: photo?.buffer?.length ? { buffer: photo.buffer, mimetype: String(photo.mimetype || '').toLowerCase(), fileName: photo.originalname || 'photo.jpg' } : null,
    });
  }

  @Post('announcements/:id/cancel') @AdminOnly()
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.telegram.cancelAnnouncement(Number(user.company_id), id);
  }
}

/** Public: Telegram calls this with every update of a connected bot (checked with the secret token). */
@Controller('integrations/telegram')
export class TelegramPublicController {
  private readonly logger = new Logger('TelegramWebhook');
  constructor(private readonly telegram: TelegramService) {}

  @Post('webhook/:id')
  @SkipThrottle()
  @HttpCode(200)
  @RawResponse()
  async receive(@Param('id', ParseIntPipe) id: number, @Body() update: TelegramUpdate, @Headers('x-telegram-bot-api-secret-token') secret?: string) {
    const row = await this.telegram.connectionForWebhook(id, secret);
    if (!row) {
      this.logger.warn(`Telegram webhook ${id} refused: wrong secret`);
      throw new ForbiddenException('Invalid Telegram secret.');
    }
    if (!update || typeof update !== 'object') throw new BadRequestException('No update.');
    // saved before Telegram gets its answer (a crash then means Telegram sends it again – duplicates are skipped);
    // one more try on a passing error, then it is logged and acknowledged so one bad update never blocks the bot
    try {
      await this.telegram.enqueue(row, update).catch(() => this.telegram.enqueue(row, update));
    } catch (error) {
      this.logger.error(`Telegram update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: true };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([BotChannelUser, BotConversation, BotMessage]), AuthModule, SalesBotModule],
  controllers: [TelegramController, TelegramPublicController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
