import {
  Body, Controller, Get, HttpCode, Module, Param, ParseIntPipe, Patch, Post, Put, Query, ServiceUnavailableException, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { SalesBotModule } from '../sales-bot/sales-bot.module';
import { CurrentCustomer, CustomerAuthGuard, type CustomerAccount } from './customer-auth';
import { APP_MAX_FILE_MB, CustomerAppService } from './customer-app.service';
import { CustomerCommunityBusinessController, CustomerCommunityController } from './customer-community.controller';
import { CustomerCommunityService } from './customer-community.service';
import { CustomerAppPart3Controller, CustomerAppPart3BusinessController, CustomerAppPublicController } from './customer-app-3.controller';
import { CustomerBroadcastService } from './customer-broadcast.service';
import { CustomerDmService } from './customer-dm.service';
import { CustomerMembersService } from './customer-members.service';
import { CustomerPushService } from './customer-push.service';

/** Customer app – login (public, rate limited). */
@Controller('ca/auth')
@ApiTags('Customer app')
export class CustomerAuthController {
  constructor(private readonly app: CustomerAppService) {}

  @Post('start')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  start(@Body() body: { phone?: string; app?: string; link?: string }) { return this.app.startLogin(String(body?.phone ?? ''), { app: body?.app, link: body?.link }); }

  @Post('verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@Body() body: { phone?: string; code?: string; name?: string; app?: string; link?: string }) {
    return this.app.verifyLogin(String(body?.phone ?? ''), String(body?.code ?? ''), body?.name, { app: body?.app, link: body?.link });
  }
}

/** Customer app – everything a logged-in customer does. */
@Controller('ca')
@ApiTags('Customer app')
@UseGuards(CustomerAuthGuard)
export class CustomerAppController {
  constructor(private readonly app: CustomerAppService) {}

  @Get('me')
  me(@CurrentCustomer() customer: CustomerAccount) {
    return { account: this.app.publicAccount(customer), realtime: this.app.realtimeEnabled(), channel: this.app.customerChannel(customer.id) };
  }

  @Patch('me')
  update(@CurrentCustomer() customer: CustomerAccount, @Body() body: { name?: string }) { return this.app.updateProfile(customer, body ?? {}); }

  @Post('logout-everywhere')
  logoutEverywhere(@CurrentCustomer() customer: CustomerAccount) { return this.app.logoutEverywhere(customer); }

  @Get('places')
  places(@CurrentCustomer() customer: CustomerAccount) { return this.app.places(customer); }

  /** from the business's link / QR code (/chat?b=<link code>) */
  @Post('open')
  open(@CurrentCustomer() customer: CustomerAccount, @Body() body: { link?: string }) { return this.app.open(customer, String(body?.link ?? '')); }

  @Get('places/:companyId/messages')
  messages(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Query('before') before?: string) {
    const beforeId = before && /^\d+$/.test(before) ? Number(before) : undefined;
    return this.app.messages(customer, companyId, beforeId);
  }

  @Post('places/:companyId/messages')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: APP_MAX_FILE_MB * 1024 * 1024 } }))
  send(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number, @Body() body: { text?: string },
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string }) {
    return this.app.send(customer, companyId, { text: body?.text, file: file?.buffer?.length ? file : null });
  }

  @Post('places/:companyId/read')
  read(@CurrentCustomer() customer: CustomerAccount, @Param('companyId', ParseIntPipe) companyId: number) { return this.app.markRead(customer, companyId); }

  @Post('realtime/auth')
  @HttpCode(200)
  @RawResponse()
  async realtime(@CurrentCustomer() customer: CustomerAccount, @Body() body: { socket_id?: string; channel_name?: string }) {
    const signature = await this.app.authorizeRealtime(customer, String(body?.socket_id ?? ''), String(body?.channel_name ?? ''));
    if (!signature) throw new ServiceUnavailableException('Real-time updates are not configured.');
    return signature;
  }
}

/** Channels → Customer app (owner): switch it on, welcome message, numbers. */
@Controller('customer-app')
@ApiTags('Customer app')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class CustomerAppBusinessController {
  constructor(private readonly app: CustomerAppService) {}

  @Get('settings') @AdminOnly()
  async settings(@CurrentUser() user: AuthenticatedUser) {
    return { ...(await this.app.settings(Number(user.company_id))), link_code: this.app.linkCode(Number(user.company_id)) };
  }

  @Put('settings') @AdminOnly()
  async save(@CurrentUser() user: AuthenticatedUser, @Body() body: {
    enabled?: boolean; welcome_text?: string | null; slug?: string; app_name?: string | null; theme_color?: string | null; access?: string; member_dm?: boolean;
  }) {
    return { ...(await this.app.saveSettings(Number(user.company_id), body ?? {})), link_code: this.app.linkCode(Number(user.company_id)) };
  }
}

@Module({
  imports: [AuthModule, SalesBotModule],
  controllers: [
    CustomerAuthController, CustomerAppPublicController, CustomerAppController, CustomerAppBusinessController, CustomerCommunityController,
    CustomerCommunityBusinessController, CustomerAppPart3Controller, CustomerAppPart3BusinessController,
  ],
  providers: [CustomerAppService, CustomerCommunityService, CustomerMembersService, CustomerPushService, CustomerDmService, CustomerBroadcastService, CustomerAuthGuard],
  exports: [CustomerAppService],
})
export class CustomerAppModule {}
