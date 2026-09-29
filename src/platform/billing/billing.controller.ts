import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { SuperAdminGuard } from '../super-admin.guard';
import { AutoRenewDto, BankDetailsDto, CheckoutDto, PaymentsQueryDto, RejectPaymentDto, TokenPackDto } from './billing.dto';
import { BillingService } from './billing.service';

type Upload = { buffer: Buffer; mimetype: string; originalname: string; size: number };

/** Company admins: packages, token packs, payments, invoices. */
@Controller('billing')
@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
  @HttpCode(200)
  async notify(@Body() body: Record<string, string>, @Res() res: Response) {
    const result = await this.billing.payhereNotify(body ?? {});
    res.type('text/plain').send(result);
  }
}

/** Metrocoding team: payments approval, bank details, token packs. */
@Controller('super-admin/billing')
@ApiTags('Super admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
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
}
