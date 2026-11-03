import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentCustomer, CustomerAuthGuard, type CustomerAccount } from './customer-auth';
import { CustomerCallsService } from './customer-calls.service';
import { CustomerCommunityService } from './customer-community.service';

const yes = (v: unknown) => v === true || v === 'true';

/** Customer app – calls and meetings (logged-in customers). */
@Controller('ca')
@ApiTags('Customer app')
@UseGuards(CustomerAuthGuard)
export class CustomerCallsController {
  constructor(private readonly calls: CustomerCallsService) {}

  @Get('calls/config')
  config() { return this.calls.config(); }

  @Get('calls/incoming')
  incoming(@CurrentCustomer() customer: CustomerAccount) { return this.calls.incoming(customer); }

  @Post('places/:companyId/call')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  callBusiness(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Body() body: { video?: boolean }) {
    return this.calls.callBusiness(customer, companyId, yes(body?.video));
  }

  @Post('dms/:id/call')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  callMember(@CurrentCustomer() customer: CustomerAccount, @Param('id', ParseIntPipe) id: number, @Body() body: { video?: boolean; e2ee?: unknown }) {
    return this.calls.callMember(customer, id, yes(body?.video), body?.e2ee);
  }

  @Get('calls/:id')
  status(@CurrentCustomer() customer: CustomerAccount, @Param('id', ParseIntPipe) id: number) { return this.calls.customerCallStatus(customer, id); }

  @Post('calls/:id/answer')
  answer(@CurrentCustomer() customer: CustomerAccount, @Param('id', ParseIntPipe) id: number) { return this.calls.answer(customer, id); }

  @Post('calls/:id/end')
  end(@CurrentCustomer() customer: CustomerAccount, @Param('id', ParseIntPipe) id: number) { return this.calls.end(customer, id); }

  @Get('places/:companyId/meetings')
  meetings(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number) { return this.calls.myMeetings(customer, companyId); }

  @Post('places/:companyId/meetings')
  createMeeting(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Body() body: Record<string, unknown>) {
    return this.calls.customerCreateMeeting(customer, companyId, body ?? {});
  }

  @Get('meetings/:code')
  meetingInfo(@CurrentCustomer() customer: CustomerAccount, @Param('code') code: string) { return this.calls.meetingInfo(customer, code); }

  @Post('meetings/:code/join')
  join(@CurrentCustomer() customer: CustomerAccount, @Param('code') code: string) { return this.calls.join(customer, code); }
}

/** Customer app (owner / team): answer and make app calls, meetings. Calls: every team member; meetings: admins. */
@Controller('customer-app')
@ApiTags('Customer app')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class CustomerCallsBusinessController {
  constructor(private readonly calls: CustomerCallsService, private readonly community: CustomerCommunityService) {}

  private company(user: AuthenticatedUser) { return Number(user.company_id); }

  @Get('calls/config')
  config() { return this.calls.config(); }

  @Get('calls/ringing')
  ringing(@CurrentUser() user: AuthenticatedUser) { return this.calls.ringing(this.company(user)); }

  @Post('calls')
  call(@CurrentUser() user: AuthenticatedUser, @Body() body: { account_id?: number; conversation_id?: number; video?: boolean }) {
    return this.calls.staffCall(this.company(user), Number(user.id), { ...body, video: yes(body?.video) });
  }

  @Get('calls/:id')
  status(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.calls.callStatus(this.company(user), id); }

  @Post('calls/:id/answer')
  answer(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.calls.staffAnswer(this.company(user), Number(user.id), id); }

  @Post('calls/:id/end')
  end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.calls.staffEnd(this.company(user), id); }

  @Get('meetings') @AdminOnly()
  meetings(@CurrentUser() user: AuthenticatedUser) { return this.calls.businessMeetings(this.company(user)); }

  @Post('meetings') @AdminOnly()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: Record<string, unknown>) { return this.calls.businessCreateMeeting(this.company(user), Number(user.id), body ?? {}); }

  @Delete('meetings/:id') @AdminOnly()
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.calls.cancelMeeting(this.company(user), id); }

  @Post('meetings/:id/join') @AdminOnly()
  join(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.calls.staffJoin(this.company(user), Number(user.id), id); }

  @Post('meetings/:id/share') @AdminOnly()
  share(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: { group_ids?: unknown }) {
    return this.calls.shareToGroups(this.company(user), Number(user.id), id, body?.group_ids,
      (groupId, text) => this.community.businessPost(this.company(user), Number(user.id), groupId, { text }));
  }

  @Put('meetings/hosts') @AdminOnly()
  hosts(@CurrentUser() user: AuthenticatedUser, @Body() body: { roles?: unknown }) { return this.calls.setHostRoles(this.company(user), body?.roles); }
}
