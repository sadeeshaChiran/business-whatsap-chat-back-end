import { SkipThrottle } from '@nestjs/throttler';
import { SuperAdminAuditInterceptor } from '../audit.interceptor';
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { SuperAdminGuard } from '../super-admin.guard';
import { AdminOnly, OwnerOnly } from '../../auth/decorators/roles.decorator';
import { AutoRenewDto, BankDetailsDto, CheckoutDto, PaymentMethodsDto, PaymentsQueryDto, PaypalRateDto, RejectPaymentDto, TokenPackDto } from './billing.dto';
import { BillingService } from './billing.service';

type Upload = { buffer: Buffer; mimetype: string; originalname: string; size: number };

/** Company admins: packages, token packs, payments, invoices. */
@Controller('billing')
@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@AdminOnly()
@OwnerOnly()
export class CompanyBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser) { return this.billing.overview(user); }

  @Post('checkout')
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckoutDto) { return this.billing.checkout(user, dto); }

  @Post('payments/:id/slip')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadSlip(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @UploadedFile() file?: Upload) {
    return this.billing.uploadSlip(user, id, file);
  }

  /** Back from PayPal (return page): take the money / check the subscription, then switch it on. */
  @Post('payments/:id/paypal')
  confirmPaypal(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.billing.confirmPaypal(user, id); }

  /** Back from the Payments.lk card page: the server confirms it with Payments.lk. */
  @Post('payments/:id/paymentslk')
  confirmPaymentsLk(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.billing.confirmPaymentsLk(user, id); }

  @Post('auto-renew')
  autoRenew(@CurrentUser() user: AuthenticatedUser, @Body() dto: AutoRenewDto) { return this.billing.setAutoRenew(user, dto.enabled); }

  @Get('payments/:id/invoice')
  async invoice(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const file = await this.billing.invoiceFile(Number(user.company_id), id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.buffer);
  }
}

/** PayHere calls this after every payment (also each auto-renew charge). No login – checked by md5sig. */
@Controller('public/payhere')
@ApiTags('Public')
export class PayhereNotifyController {
  constructor(private readonly billing: BillingService) {}

  @Post('notify')
  @SkipThrottle()
  @HttpCode(200)
  async notify(@Body() body: Record<string, string>, @Res() res: Response) {
    const result = await this.billing.payhereNotify(body ?? {});
    res.type('text/plain').send(result);
  }
}

/** PayPal webhook (payments, every auto-renew charge, cancelled subscriptions). No login – PayPal confirms each call. */
@Controller('public/paypal')
@ApiTags('Public')
export class PaypalWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post('webhook')
  @SkipThrottle()
  async webhook(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body ?? {});
    const result = await this.billing.paypalWebhook(req.headers, raw);
    res.status(result === 'ok' ? 200 : result === 'invalid' ? 400 : 500).json({ ok: result === 'ok' });
  }
}

/** Payments.lk webhook (payments, saved cards, refunds). No login – the Payments-Signature header is checked. */
@Controller('public/paymentslk')
@ApiTags('Public')
export class PaymentsLkWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post('webhook')
  @SkipThrottle()
  async webhook(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    const sig = req.headers['payments-signature'];
    const result = await this.billing.paymentsLkWebhook(raw, Array.isArray(sig) ? sig[0] : sig);
    res.status(result === 'ok' ? 200 : result === 'invalid' ? 400 : 500).json({ ok: result === 'ok' });
  }
}

/** Metrocoding team: payments approval, bank details, token packs. */
@Controller('super-admin/billing')
@ApiTags('Super admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@UseInterceptors(SuperAdminAuditInterceptor)
export class SuperAdminBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('payments')
  payments(@Query() query: PaymentsQueryDto) { return this.billing.adminPayments(query.status); }

  @Get('payments/:id/slip')
  async slip(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const file = await this.billing.slipFile(id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`);
    res.send(file.buffer);
  }

  @Get('payments/:id/invoice')
  async invoice(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const file = await this.billing.invoiceFile(null, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.buffer);
  }

  @Post('payments/:id/approve')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) { return this.billing.approve(id, user); }

  @Post('payments/:id/reject')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectPaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.billing.reject(id, dto.reason, user);
  }

  @Get('bank-details')
  bankDetails() { return this.billing.bankDetails(); }

  @Put('bank-details')
  setBankDetails(@Body() dto: BankDetailsDto) { return this.billing.setBankDetails(dto); }

  @Get('token-packs')
  packs() { return this.billing.listPacks(); }

  @Post('token-packs')
  createPack(@Body() dto: TokenPackDto) { return this.billing.savePack(dto); }

  @Patch('token-packs/:id')
  updatePack(@Param('id', ParseIntPipe) id: number, @Body() dto: TokenPackDto) { return this.billing.savePack(dto, id); }

  @Get('settings')
  settings() { return this.billing.billingSettings(); }

  /** Which ways of paying businesses see: Card (Payments.lk), PayPal, Bank transfer, PayHere. */
  @Put('settings/methods')
  methods(@Body() dto: PaymentMethodsDto) { return this.billing.setPaymentMethods(dto); }

  /** Payments.lk auto-renew: charge the saved cards that are due now (it also runs every hour by itself). */
  @Post('renewals/run')
  async runRenewals() { await this.billing.renewWithSavedCards(); return { ok: true }; }

  /** PayPal: rupees → US dollars (rate of the day or a fixed rate) and the markup. */
  @Put('settings/paypal')
  paypalRate(@Body() dto: PaypalRateDto) { return this.billing.setPaypalRate(dto); }
}
