import { Body, Controller, Delete, Get, Module, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SmsService, type SmsAudience } from './sms.service';

/** SMS with the business's own Notify.lk account: connect, campaigns, one SMS from a chat, do-not-SMS list. */
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

@Module({ imports: [AuthModule], controllers: [SmsController], providers: [SmsService] })
export class SmsModule {}
