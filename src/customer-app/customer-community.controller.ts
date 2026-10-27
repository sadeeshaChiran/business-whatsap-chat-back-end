import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentCustomer, CustomerAuthGuard, type CustomerAccount } from './customer-auth';
import { CustomerCommunityService } from './customer-community.service';

type Upload = { buffer: Buffer; mimetype: string; originalname: string };
const upload = (field: string, mb: number) => UseInterceptors(FileInterceptor(field, { storage: memoryStorage(), limits: { fileSize: mb * 1024 * 1024 } }));
const before = (value?: string) => (value && /^\d+$/.test(value) ? Number(value) : undefined);
const yes = (value: unknown) => value === true || value === 'true';

/** Customer app – a business's page (profile, news, groups) and the customer's own settings. */
@Controller('ca')
@ApiTags('Customer app')
@UseGuards(CustomerAuthGuard)
export class CustomerCommunityController {
  constructor(private readonly community: CustomerCommunityService) {}

  @Get('profile')
  me(@CurrentCustomer() customer: CustomerAccount) { return this.community.me(customer); }

  @Patch('profile')
  settings(@CurrentCustomer() customer: CustomerAccount, @Body() body: { show_name?: boolean; allow_dm?: boolean; show_last_seen?: boolean }) { return this.community.updateSettings(customer, body ?? {}); }

  @Post('profile/photo')
  @upload('photo', 5)
  photo(@CurrentCustomer() customer: CustomerAccount, @UploadedFile() file?: Upload) { return this.community.setAvatar(customer, file ?? null); }

  @Delete('profile/photo')
  removePhoto(@CurrentCustomer() customer: CustomerAccount) { return this.community.setAvatar(customer, null); }

  @Delete('profile')
  deleteAccount(@CurrentCustomer() customer: CustomerAccount) { return this.community.deleteAccount(customer); }

  @Get('places/:companyId/profile')
  profile(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number) { return this.community.profile(customer, companyId); }

  @Put('places/:companyId/mute')
  muteBusiness(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Body() body: { muted?: boolean }) {
    return this.community.setBusinessMuted(customer, companyId, yes(body?.muted));
  }

  @Get('places/:companyId/news')
  news(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Query('before') b?: string) {
    return this.community.news(customer, companyId, before(b));
  }

  @Get('places/:companyId/groups')
  groups(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number) { return this.community.groups(customer, companyId); }

  @Post('groups/:groupId/join')
  join(@CurrentCustomer() customer: CustomerAccount, @Param('groupId', ParseIntPipe) groupId: number) { return this.community.joinGroup(customer, groupId); }

  @Post('groups/:groupId/leave')
  leave(@CurrentCustomer() customer: CustomerAccount, @Param('groupId', ParseIntPipe) groupId: number) { return this.community.leaveGroup(customer, groupId); }

  @Put('groups/:groupId/mute')
  muteGroup(@CurrentCustomer() customer: CustomerAccount, @Param('groupId', ParseIntPipe) groupId: number, @Body() body: { muted?: boolean }) {
    return this.community.setGroupMuted(customer, groupId, yes(body?.muted));
  }

  @Get('groups/:groupId/messages')
  groupMessages(@CurrentCustomer() customer: CustomerAccount, @Param('groupId', ParseIntPipe) groupId: number, @Query('before') b?: string) {
    return this.community.groupMessages(customer, groupId, before(b));
  }

  @Post('groups/:groupId/messages')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @upload('file', 25)
  post(@CurrentCustomer() customer: CustomerAccount, @Param('groupId', ParseIntPipe) groupId: number, @Body() body: { text?: string }, @UploadedFile() file?: Upload) {
    return this.community.postToGroup(customer, groupId, { text: body?.text, file: file ?? null });
  }

  @Delete('groups/:groupId/messages/:messageId')
  deleteMessage(@CurrentCustomer() customer: CustomerAccount, @Param('groupId', ParseIntPipe) groupId: number, @Param('messageId', ParseIntPipe) messageId: number) {
    return this.community.deleteOwnGroupMessage(customer, groupId, messageId);
  }

  @Get('groups/:groupId/members')
  members(@CurrentCustomer() customer: CustomerAccount, @Param('groupId', ParseIntPipe) groupId: number) { return this.community.groupMembers(customer, groupId); }
}

/** Channels → Customer app (owner): business profile, news, groups. */
@Controller('customer-app')
@ApiTags('Customer app')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class CustomerCommunityBusinessController {
  constructor(private readonly community: CustomerCommunityService) {}

  private company(user: AuthenticatedUser) { return Number(user.company_id); }

  @Get('profile') @AdminOnly()
  profile(@CurrentUser() user: AuthenticatedUser) { return this.community.businessProfile(this.company(user)); }

  @Put('profile') @AdminOnly()
  saveProfile(@CurrentUser() user: AuthenticatedUser, @Body() body: Record<string, unknown>) { return this.community.saveBusinessProfile(this.company(user), body ?? {}); }

  @Post('profile/logo') @AdminOnly()
  @upload('logo', 5)
  logo(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file?: Upload) { return this.community.setLogo(this.company(user), file ?? null); }

  @Delete('profile/logo') @AdminOnly()
  removeLogo(@CurrentUser() user: AuthenticatedUser) { return this.community.setLogo(this.company(user), null); }

  @Get('news') @AdminOnly()
  news(@CurrentUser() user: AuthenticatedUser) { return this.community.businessNews(this.company(user)); }

  @Post('news') @AdminOnly()
  @upload('photo', 10)
  postNews(@CurrentUser() user: AuthenticatedUser, @Body() body: Record<string, unknown>, @UploadedFile() file?: Upload) {
    return this.community.postNews(this.company(user), Number(user.id), body ?? {}, file ?? null);
  }

  @Patch('news/:id') @AdminOnly()
  updateNews(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) {
    return this.community.updateNews(this.company(user), id, body ?? {});
  }

  @Delete('news/:id') @AdminOnly()
  deleteNews(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.community.deleteNews(this.company(user), id); }

  @Get('groups') @AdminOnly()
  groups(@CurrentUser() user: AuthenticatedUser) { return this.community.businessGroups(this.company(user)); }

  @Post('groups') @AdminOnly()
  createGroup(@CurrentUser() user: AuthenticatedUser, @Body() body: Record<string, unknown>) { return this.community.createGroup(this.company(user), Number(user.id), body ?? {}); }

  @Patch('groups/:id') @AdminOnly()
  updateGroup(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) {
    return this.community.updateGroup(this.company(user), id, body ?? {});
  }

  @Delete('groups/:id') @AdminOnly()
  deleteGroup(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.community.archiveGroup(this.company(user), id); }

  @Get('groups/:id/members') @AdminOnly()
  members(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.community.businessMembers(this.company(user), id); }

  @Post('groups/:id/members') @AdminOnly()
  addMembers(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: { account_ids?: unknown; tags?: unknown }) {
    return this.community.addMembers(this.company(user), id, body ?? {});
  }

  @Patch('groups/:id/members/:accountId') @AdminOnly()
  setRole(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Param('accountId', ParseIntPipe) accountId: number, @Body() body: { role?: string }) {
    return this.community.setMemberRole(this.company(user), id, accountId, String(body?.role ?? 'member'));
  }

  @Delete('groups/:id/members/:accountId') @AdminOnly()
  removeMember(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Param('accountId', ParseIntPipe) accountId: number) {
    return this.community.removeMember(this.company(user), id, accountId);
  }

  @Get('app-customers') @AdminOnly()
  appCustomers(@CurrentUser() user: AuthenticatedUser, @Query('q') q?: string) { return this.community.appCustomers(this.company(user), q ?? ''); }

  @Get('groups/:id/messages') @AdminOnly()
  messages(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Query('before') b?: string) {
    return this.community.businessGroupMessages(this.company(user), id, before(b));
  }

  @Post('groups/:id/messages') @AdminOnly()
  @upload('file', 25)
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: { text?: string }, @UploadedFile() file?: Upload) {
    return this.community.businessPost(this.company(user), Number(user.id), id, { text: body?.text, file: file ?? null });
  }

  @Delete('groups/:id/messages/:messageId') @AdminOnly()
  deleteMessage(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Param('messageId', ParseIntPipe) messageId: number) {
    return this.community.businessDeleteMessage(this.company(user), id, messageId);
  }
}
