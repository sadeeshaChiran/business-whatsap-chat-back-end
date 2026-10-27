import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { APP_MAX_FILE_MB } from './customer-app.service';
import { CurrentCustomer, CustomerAuthGuard, type CustomerAccount } from './customer-auth';
import { CustomerTeamService } from './customer-team.service';

type Upload = { buffer: Buffer; mimetype: string; originalname: string };
const before = (value?: string) => (value && /^\d+$/.test(value) ? Number(value) : undefined);
const yes = (value: unknown) => value === true || value === 'true' || value === '1';

/** The business's team inside its own app (owner and agents, logged in with their mobile number). */
@Controller('ca/team/:companyId')
@ApiTags('Customer app')
@UseGuards(CustomerAuthGuard)
export class CustomerTeamController {
  constructor(private readonly team: CustomerTeamService) {}

  @Get()
  me(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number) { return this.team.me(c, companyId); }

  @Get('chats')
  chats(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Query('q') q?: string) { return this.team.chats(c, companyId, q ?? ''); }

  @Get('chats/:id')
  messages(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Param('id', ParseIntPipe) id: number, @Query('before') b?: string) {
    return this.team.messages(c, companyId, id, before(b));
  }

  @Post('chats/:id/messages')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: APP_MAX_FILE_MB * 1024 * 1024 } }))
  send(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Param('id', ParseIntPipe) id: number,
    @Body() body: { text?: string }, @UploadedFile() file?: Upload) {
    return this.team.send(c, companyId, id, { text: body?.text, file: file ?? null });
  }

  @Post('chats/:id/read')
  read(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Param('id', ParseIntPipe) id: number) { return this.team.read(c, companyId, id); }

  @Get('groups')
  groups(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number) { return this.team.groups(c, companyId); }

  @Get('calls/ringing')
  ringing(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number) { return this.team.ringing(c, companyId); }

  @Post('calls')
  call(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Body() body: { conversation_id?: number; video?: unknown }) {
    return this.team.call(c, companyId, { conversation_id: Number(body?.conversation_id), video: yes(body?.video) });
  }

  @Get('calls/:id')
  callStatus(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Param('id', ParseIntPipe) id: number) { return this.team.callStatus(c, companyId, id); }

  @Post('calls/:id/answer')
  answer(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Param('id', ParseIntPipe) id: number) { return this.team.answer(c, companyId, id); }

  @Post('calls/:id/end')
  end(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Param('id', ParseIntPipe) id: number) { return this.team.end(c, companyId, id); }

  @Get('meetings')
  meetings(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number) { return this.team.meetings(c, companyId); }

  @Post('meetings')
  createMeeting(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Body() body: Record<string, unknown>) {
    return this.team.createMeeting(c, companyId, body ?? {});
  }

  @Delete('meetings/:id')
  cancelMeeting(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Param('id', ParseIntPipe) id: number) { return this.team.cancelMeeting(c, companyId, id); }

  @Post('meetings/:id/join')
  joinMeeting(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Param('id', ParseIntPipe) id: number) { return this.team.joinMeeting(c, companyId, id); }

  @Post('meetings/:id/share')
  share(@CurrentCustomer() c: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Param('id', ParseIntPipe) id: number, @Body() body: { group_ids?: unknown }) {
    return this.team.shareMeeting(c, companyId, id, body?.group_ids);
  }
}

/** Dashboard → Customer app → Team: the mobile numbers the team logs into the app with. */
@Controller('customer-app/team')
@ApiTags('Customer app')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class CustomerTeamBusinessController {
  constructor(private readonly team: CustomerTeamService) {}

  @Get() @AdminOnly()
  list(@CurrentUser() user: AuthenticatedUser) { return this.team.teamList(Number(user.company_id)); }

  @Put(':userId/mobile') @AdminOnly()
  mobile(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseIntPipe) userId: number, @Body() body: { mobile?: string }) {
    return this.team.setMobile(Number(user.company_id), userId, body?.mobile);
  }
}
