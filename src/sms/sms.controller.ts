import { Body, Controller, Delete, Get, Module, Param, ParseIntPipe, Patch, Post, Put, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SuperAdminAuditInterceptor } from '../platform/audit.interceptor';
import { SuperAdminGuard } from '../platform/super-admin.guard';
import { SmsService, type SmsAudience } from './sms.service';

/** SMS: Agent Metra SMS credits or the business's own Notify.lk account; campaigns, one SMS from a chat, do-not-SMS list. */
@Controller('sms')
@ApiTags('SMS')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class SmsController {
  constructor(private readonly sms: SmsService) {}
  private company(user: AuthenticatedUser) { return Number(user.company_id); }

  @Get('ready')
  ready(@CurrentUser() user: AuthenticatedUser) { return this.sms.ready(this.company(user)); }

  @Get('settings') @AdminOnly()
  settings(@CurrentUser() user: AuthenticatedUser) { return this.sms.settings(this.company(user)); }

  @Put('settings') @AdminOnly()
  connect(@CurrentUser() user: AuthenticatedUser, @Body() body: { user_id?: string; api_key?: string; sender_id?: string; footer?: string | null }) { return this.sms.connect(user, body ?? {}); }

  @Post('settings/refresh') @AdminOnly()
  refresh(@CurrentUser() user: AuthenticatedUser) { return this.sms.refresh(this.company(user)); }

  @Delete('settings') @AdminOnly()
  disconnect(@CurrentUser() user: AuthenticatedUser) { return this.sms.disconnect(this.company(user)); }

  /** Agent Metra SMS: ask for your own sender name, the line added to every SMS, credits history. */
  @Post('sender') @AdminOnly()
  sender(@CurrentUser() user: AuthenticatedUser, @Body() body: { sender_id?: string }) { return this.sms.requestSender(user, body?.sender_id); }

  @Put('footer') @AdminOnly()
  footer(@CurrentUser() user: AuthenticatedUser, @Body() body: { footer?: string | null }) { return this.sms.setFooter(this.company(user), body?.footer); }

  @Get('credits/history') @AdminOnly()
  history(@CurrentUser() user: AuthenticatedUser) { return this.sms.history(this.company(user)); }

  @Post('test') @AdminOnly()
  test(@CurrentUser() user: AuthenticatedUser, @Body() body: { to?: string }) { return this.sms.test(user, body?.to); }

  @Get('tags') @AdminOnly()
  tags(@CurrentUser() user: AuthenticatedUser) { return this.sms.tags(this.company(user)); }

  @Post('preview') @AdminOnly()
  preview(@CurrentUser() user: AuthenticatedUser, @Body() body: { audience?: SmsAudience; text?: string }) { return this.sms.preview(this.company(user), body?.audience ?? {}, body?.text ?? ''); }

  @Get('campaigns') @AdminOnly()
  campaigns(@CurrentUser() user: AuthenticatedUser) { return this.sms.campaigns(this.company(user)); }

  @Post('campaigns') @AdminOnly()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: { name?: string; text?: string; audience?: SmsAudience }) { return this.sms.createCampaign(user, body ?? {}); }

  @Get('campaigns/:id') @AdminOnly()
  campaign(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.sms.campaign(this.company(user), id); }

  @Post('campaigns/:id/stop') @AdminOnly()
  stop(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.sms.stop(this.company(user), id); }

  @Get('optouts') @AdminOnly()
  optouts(@CurrentUser() user: AuthenticatedUser) { return this.sms.optouts(this.company(user)); }

  @Put('optouts') @AdminOnly()
  optout(@CurrentUser() user: AuthenticatedUser, @Body() body: { phone?: string; opted_out?: boolean }) { return this.sms.setOptout(this.company(user), body?.phone, body?.opted_out !== false); }

  /** Inbox: can this chat get an SMS (and to which number)? Any team member with access to the chat. */
  @Get('conversations/:id')
  chat(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.sms.chatInfo(user, id); }

  @Post('conversations/:id')
  send(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: { text?: string }) { return this.sms.sendToChat(user, id, body?.text); }
}

/** Metrocoding team: the Agent Metra Notify.lk account, SMS packs, sender names, credits. */
@Controller('super-admin/sms')
@ApiTags('Super admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@UseInterceptors(SuperAdminAuditInterceptor)
export class SuperAdminSmsController {
  constructor(private readonly sms: SmsService) {}

  @Get()
  overview() { return this.sms.adminOverview(); }

  @Put()
  save(@Body() body: { enabled?: boolean; user_id?: string; api_key?: string; default_sender?: string }) { return this.sms.savePlatform(body ?? {}); }

  @Post('refresh')
  refresh() { return this.sms.refreshPlatform(); }

  @Get('packs')
  packs() { return this.sms.adminPacks(); }

  @Post('packs')
  createPack(@Body() body: { name?: string; credits?: number; price?: number; is_active?: boolean; sort_order?: number }) { return this.sms.savePack(body ?? {}); }

  @Patch('packs/:id')
  updatePack(@Param('id', ParseIntPipe) id: number, @Body() body: { name?: string; credits?: number; price?: number; is_active?: boolean; sort_order?: number }) { return this.sms.savePack(body ?? {}, id); }

  @Get('companies')
  wallets() { return this.sms.adminWallets(); }

  @Post('companies/:id/sender')
  decide(@Param('id', ParseIntPipe) id: number, @Body() body: { approve?: boolean; sender_id?: string; note?: string }) { return this.sms.decideSender(id, body ?? {}); }

  @Post('companies/:id/credits')
  adjust(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: { credits?: number; note?: string }) { return this.sms.adjust(user, id, body ?? {}); }
}

@Module({ imports: [AuthModule], controllers: [SmsController, SuperAdminSmsController], providers: [SmsService] })
export class SmsModule {}
