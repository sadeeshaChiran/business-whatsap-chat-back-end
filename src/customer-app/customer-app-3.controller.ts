import {
  Body, Controller, Delete, Get, Header, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { CustomerAppService } from './customer-app.service';
import { CurrentCustomer, CustomerAuthGuard, type CustomerAccount } from './customer-auth';
import { CustomerBroadcastService } from './customer-broadcast.service';
import { CustomerDmService } from './customer-dm.service';
import { CustomerMembersService } from './customer-members.service';
import { CustomerPushService } from './customer-push.service';

type Upload = { buffer: Buffer; mimetype: string; originalname: string };
const upload = (field: string, mb: number) => UseInterceptors(FileInterceptor(field, { storage: memoryStorage(), limits: { fileSize: mb * 1024 * 1024 } }));
const before = (value?: string) => (value && /^\d+$/.test(value) ? Number(value) : undefined);
const list = (value: unknown): string[] => (Array.isArray(value) ? value : String(value ?? '').split(',')).map((v) => String(v).trim()).filter(Boolean);
const yes = (value: unknown) => value === true || value === 'true' || value === '1';

/** Public: a business's app as seen before login – name, logo, install manifest and home-screen icon. Nothing private. */
@Controller('ca/app')
@ApiTags('Customer app')
@SkipThrottle()
export class CustomerAppPublicController {
  constructor(private readonly members: CustomerMembersService) {}

  @Get(':slug')
  info(@Param('slug') slug: string) { return this.members.appInfo(slug); }

  @Get(':slug/manifest.webmanifest')
  @RawResponse()
  @Header('Content-Type', 'application/manifest+json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  manifest(@Param('slug') slug: string, @Query('o') origin?: string) { return this.members.manifest(slug, origin); }

  @Get(':slug/icon.png')
  async icon(@Param('slug') slug: string, @Res() res: Response) {
    const file = await this.members.icon(slug);
    if (!file) throw new NotFoundException('No icon.');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(file.buffer);
  }
}

/** Customer app part 3 – logged-in customers: open a business's app, notifications, member chats, block, report. */
@Controller('ca')
@ApiTags('Customer app')
@UseGuards(CustomerAuthGuard)
export class CustomerAppPart3Controller {
  constructor(private readonly app: CustomerAppService, private readonly push: CustomerPushService, private readonly dms: CustomerDmService) {}

  /** /app/<address> opened: may I use it? (marks "has the app" for the business) */
  @Post('app/:slug/open')
  open(@CurrentCustomer() customer: CustomerAccount, @Param('slug') slug: string) { return this.app.openApp(customer, slug); }

  @Get('push')
  pushStatus(@CurrentCustomer() customer: CustomerAccount, @Query('endpoint') endpoint?: string) { return this.push.status(customer, endpoint || undefined); }

  @Post('push')
  subscribe(@CurrentCustomer() customer: CustomerAccount, @Body() body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; company_id?: number }) {
    return this.push.subscribe(customer, body ?? {});
  }

  @Delete('push')
  unsubscribe(@CurrentCustomer() customer: CustomerAccount, @Body() body: { endpoint?: string }) { return this.push.unsubscribe(customer, String(body?.endpoint ?? '')); }

  @Get('places/:companyId/dms')
  dmList(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number) { return this.dms.list(customer, companyId); }

  @Post('places/:companyId/dms')
  dmStart(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Body() body: { member?: string }) {
    return this.dms.start(customer, companyId, String(body?.member ?? ''));
  }

  @Get('dms/:id/messages')
  dmMessages(@CurrentCustomer() customer: CustomerAccount, @Param('id', ParseIntPipe) id: number, @Query('before') b?: string) {
    return this.dms.messages(customer, id, before(b));
  }

  @Post('dms/:id/messages')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @upload('file', 25)
  dmSend(@CurrentCustomer() customer: CustomerAccount, @Param('id', ParseIntPipe) id: number, @Body() body: { text?: string }, @UploadedFile() file?: Upload) {
    return this.dms.send(customer, id, { text: body?.text, file: file ?? null });
  }

  @Delete('dms/:id/messages/:messageId')
  dmDelete(@CurrentCustomer() customer: CustomerAccount, @Param('id', ParseIntPipe) id: number, @Param('messageId', ParseIntPipe) messageId: number) {
    return this.dms.deleteOwn(customer, id, messageId);
  }

  @Put('blocks/:member')
  block(@CurrentCustomer() customer: CustomerAccount, @Param('member') member: string, @Body() body: { blocked?: boolean }) {
    return this.dms.block(customer, member, body?.blocked !== false);
  }

  @Post('places/:companyId/report')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  report(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number,
    @Body() body: { member?: string; group_id?: number; group_message_id?: number; dm_message_id?: number; reason?: string }) {
    return this.dms.report(customer, companyId, body ?? {});
  }
}

/** Channels → Customer app (owner): app icon, who may use the app, broadcasts, reports. */
@Controller('customer-app')
@ApiTags('Customer app')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class CustomerAppPart3BusinessController {
  constructor(
    private readonly app: CustomerAppService,
    private readonly members: CustomerMembersService,
    private readonly broadcasts: CustomerBroadcastService,
    private readonly dms: CustomerDmService,
  ) {}

  private company(user: AuthenticatedUser) { return Number(user.company_id); }

  @Post('icon') @AdminOnly()
  @upload('icon', 2)
  async icon(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file?: Upload) {
    return { ...(await this.app.setIcon(this.company(user), file ?? null)), link_code: this.app.linkCode(this.company(user)) };
  }

  @Get('members') @AdminOnly()
  list(@CurrentUser() user: AuthenticatedUser, @Query('status') status?: string, @Query('q') q?: string, @Query('page') page?: string) {
    return this.members.members(this.company(user), { status, q, page: Number(page) || 1 });
  }

  @Post('members') @AdminOnly()
  add(@CurrentUser() user: AuthenticatedUser, @Body() body: { contact_ids?: unknown; tags?: unknown; all_contacts?: unknown; phones?: unknown }) {
    return this.members.addMembers(this.company(user), Number(user.id), body ?? {});
  }

  @Delete('members/:phone') @AdminOnly()
  remove(@CurrentUser() user: AuthenticatedUser, @Param('phone') phone: string) { return this.members.removeMember(this.company(user), phone); }

  @Get('contacts') @AdminOnly()
  contacts(@CurrentUser() user: AuthenticatedUser, @Query('q') q?: string, @Query('tag') tag?: string, @Query('page') page?: string) {
    return this.members.contacts(this.company(user), { q, tag, page: Number(page) || 1 });
  }

  @Get('broadcasts') @AdminOnly()
  broadcastList(@CurrentUser() user: AuthenticatedUser) { return this.broadcasts.list(this.company(user)); }

  @Get('broadcasts/audience') @AdminOnly()
  audience(@CurrentUser() user: AuthenticatedUser, @Query('all') all?: string, @Query('tags') tags?: string, @Query('groups') groups?: string) {
    return this.broadcasts.audience(this.company(user), { all: yes(all), tags: list(tags), group_ids: list(groups).map(Number) });
  }

  @Post('broadcasts') @AdminOnly()
  @upload('photo', 10)
  send(@CurrentUser() user: AuthenticatedUser, @Body() body: Record<string, unknown>, @UploadedFile() photo?: Upload) {
    return this.broadcasts.create(this.company(user), Number(user.id), {
      text: String(body?.text ?? ''), all: yes(body?.all), tags: list(body?.tags), group_ids: list(body?.group_ids).map(Number),
    }, photo ?? null);
  }

  @Post('broadcasts/:id/cancel') @AdminOnly()
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.broadcasts.cancel(this.company(user), id); }

  @Get('reports') @AdminOnly()
  reports(@CurrentUser() user: AuthenticatedUser, @Query('resolved') resolved?: string) { return this.dms.reports(this.company(user), !yes(resolved)); }

  @Patch('reports/:id') @AdminOnly()
  resolve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.dms.resolve(this.company(user), Number(user.id), id); }
}
