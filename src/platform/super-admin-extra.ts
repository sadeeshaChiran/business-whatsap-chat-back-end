import { BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SuperAdminAuditInterceptor } from './audit.interceptor';
import { BillingService } from './billing/billing.service';
import { SuperAdminGuard } from './super-admin.guard';
import { TokenQuotaService } from './token-quota.service';

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export class AnnouncementDto {
  @IsString() @MinLength(3) @MaxLength(255) title: string;
  @IsString() @MinLength(3) @MaxLength(2000) message: string;
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH']) priority?: 'LOW' | 'MEDIUM' | 'HIGH';
  /** empty = all companies */
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @Type(() => Number) @IsInt({ each: true }) company_ids?: number[];
}

export class ManualPaymentDto {
  @IsIn(['subscription', 'token_pack']) kind: 'subscription' | 'token_pack';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) package_id?: number;
  @IsOptional() @IsIn(['monthly', 'yearly']) billing_cycle?: 'monthly' | 'yearly';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) token_pack_id?: number;
  @Type(() => Number) @IsNumber() @Min(0) amount: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class CompanyStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED']) status: 'ACTIVE' | 'SUSPENDED';
}

export class AddSuperAdminDto {
  @IsEmail() email: string;
}

export class RevenueQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) months?: number;
}

const csv = (rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    let text = value instanceof Date ? value.toISOString() : value == null ? '' : String(value);
    // stop spreadsheet formula injection (=, +, -, @ at the start of a cell)
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((key) => cell(row[key])).join(','))].join('\n');
};

/** Revenue, company 360, announcements, manual payments, exports, audit log, super admins, system health. */
@Injectable()
export class SuperAdminExtraService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly billing: BillingService,
    private readonly quota: TokenQuotaService,
    private readonly auth: AuthService,
  ) {}

  async revenue(monthsRaw?: number) {
    const months = Math.min(Math.max(Number(monthsRaw) || 12, 1), 36);
    const monthly: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT to_char(m, 'YYYY-MM') AS month,
             COALESCE((SELECT SUM(amount) FROM platform_payment p WHERE p.status = 'paid' AND date_trunc('month', p.paid_at) = m), 0) AS revenue,
             (SELECT COUNT(*) FROM platform_payment p WHERE p.status = 'paid' AND date_trunc('month', p.paid_at) = m)::int AS payments,
             COALESCE((SELECT SUM(amount) FROM platform_payment p WHERE p.status = 'paid' AND p.kind = 'token_pack' AND date_trunc('month', p.paid_at) = m), 0) AS topups
        FROM generate_series(date_trunc('month', NOW()) - make_interval(months => $1::int - 1), date_trunc('month', NOW()), INTERVAL '1 month') m
       ORDER BY m`, [months]);
    const [mrr] = await this.dataSource.query(`
      SELECT COALESCE(SUM(CASE WHEN s.billing_cycle = 'yearly' THEN p.price_yearly / 12 ELSE p.price_monthly END), 0) AS mrr,
             COUNT(*) FILTER (WHERE p.price_monthly > 0)::int AS paying
        FROM company_subscription s JOIN platform_package p ON p.id = s.package_id
       WHERE s.status = 'active' AND p.price_monthly > 0`);
    const renewals = await this.dataSource.query(`
      SELECT s.company_id, c.company_name AS name, p.name AS package, s.billing_cycle, s.period_end, s.auto_renew
        FROM company_subscription s JOIN platform_package p ON p.id = s.package_id LEFT JOIN companies c ON c.id = s.company_id
       WHERE s.period_end IS NOT NULL AND s.period_end BETWEEN NOW() AND NOW() + INTERVAL '14 days' ORDER BY s.period_end`);
    const [pending] = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM platform_payment WHERE status = 'awaiting_approval'`);
    return {
      monthly: monthly.map((row) => ({ month: String(row.month), revenue: num(row.revenue), payments: num(row.payments), topups: num(row.topups) })),
      mrr: num(mrr?.mrr), paying_companies: num(mrr?.paying), renewals_14d: renewals, slips_waiting: num(pending?.n),
      revenue_this_month: num(monthly[monthly.length - 1]?.revenue),
    };
  }

  async company360(id: number) {
    const [company] = await this.dataSource.query(`SELECT id, company_name AS name, email, phone, business_category, status, created_at FROM companies WHERE id = $1`, [id]);
    if (!company) throw new NotFoundException('Company not found.');
    const users = await this.dataSource.query(`
      SELECT u.id, u.name, u.email, u.is_active, u.is_agent_active, u.access_disabled, u.last_login_at, (u.id = c.admin_user_id) AS is_admin, u.created_at
        FROM app_user u JOIN companies c ON c.id = u.company_id WHERE u.company_id = $1 ORDER BY is_admin DESC, u.id`, [id]);
    const [counts] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(*) FROM bot_conversation cv JOIN bot_channel_user cu ON cu.id = cv.bot_channel_user_id WHERE CAST(cu.company_id AS BIGINT) = $1)::int AS conversations,
        (SELECT COUNT(*) FROM bot_channel_user cu WHERE CAST(cu.company_id AS BIGINT) = $1)::int AS customers,
        (SELECT COUNT(*) FROM bot_order o WHERE CAST(o.company_id AS BIGINT) = $1)::int AS orders,
        (SELECT COALESCE(SUM(total_amount), 0) FROM bot_order o WHERE CAST(o.company_id AS BIGINT) = $1 AND o.created_at > NOW() - INTERVAL '30 days' AND o.status::text <> 'Cancelled') AS order_value_30d,
        (SELECT COUNT(*) FROM product p WHERE p.company_id = $1 AND NOT p.is_deleted)::int AS products,
        (SELECT COUNT(*) FROM bot_ai_usage a WHERE a.company_id = $1 AND a.created_at > NOW() - INTERVAL '30 days')::int AS bot_replies_30d`, [id]).catch(() => [{}]);
    const channels = await this.dataSource.query(`
      SELECT
        (SELECT provider_type FROM whatsapp_channels w WHERE w.company_id = $1 LIMIT 1) AS whatsapp_provider,
        (SELECT COUNT(*) FROM whatsapp_channels w WHERE w.company_id = $1)::int AS whatsapp_channels,
        (SELECT page_name FROM meta_page_connections m WHERE m.company_id = $1 AND m.status = 'CONNECTED' ORDER BY id DESC LIMIT 1) AS facebook_page,
        (SELECT instagram_business_account_id FROM meta_page_connections m WHERE m.company_id = $1 AND m.status = 'CONNECTED' ORDER BY id DESC LIMIT 1) AS instagram_account`, [id])
      .then((rows: Array<Record<string, unknown>>) => rows[0]).catch(() => ({}));
    const payments = await this.dataSource.query(
      `SELECT id, description, amount, method, status, paid_at, created_at, invoice_no FROM platform_payment WHERE company_id = $1 ORDER BY id DESC LIMIT 20`, [id]);
    return { company, users, counts, channels, payments, usage: await this.quota.usage(id) };
  }

  async announce(dto: AnnouncementDto, user: AuthenticatedUser) {
    const ids: number[] = dto.company_ids?.length
      ? dto.company_ids
      : (await this.dataSource.query(`SELECT id FROM companies`)).map((row: { id: number }) => Number(row.id));
    for (const companyId of ids) {
      await this.dataSource.query(
        `INSERT INTO bot_notification (company_id, kind, priority, title, message) VALUES ($1, 'announcement', $2, $3, $4)`,
        [companyId, dto.priority ?? 'MEDIUM', `📣 ${dto.title}`, dto.message]);
    }
    const [row] = await this.dataSource.query(
      `INSERT INTO platform_announcement (title, message, priority, company_ids, recipients, created_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *`,
      [dto.title, dto.message, dto.priority ?? 'MEDIUM', dto.company_ids?.length ? JSON.stringify(dto.company_ids) : null, ids.length, user.id]);
    return row;
  }

  /** Suspend / re-activate a workspace. Suspended: nobody of that company can sign in, the bot stops. */
  async setCompanyStatus(id: number, status: 'ACTIVE' | 'SUSPENDED') {
    const [company] = await this.dataSource.query(`SELECT id FROM companies WHERE id = $1`, [id]);
    if (!company) throw new NotFoundException('Company not found.');
    await this.dataSource.query(`UPDATE companies SET status = $2, updated_at = NOW() WHERE id = $1`, [id, status]);
    if (status === 'SUSPENDED') {
      // sign everybody of the workspace out right away
      await this.dataSource.query(`UPDATE app_user SET token_version = token_version + 1, is_agent_active = FALSE WHERE company_id = $1 AND is_super_admin = FALSE`, [id]);
      await this.dataSource.query(`UPDATE companies SET bot_enabled = FALSE WHERE id = $1`, [id]);
    }
    this.auth.invalidateCompany(id);
    return { id, status };
  }

  announcements() {
    return this.dataSource.query(`SELECT * FROM platform_announcement ORDER BY id DESC LIMIT 50`);
  }

  async manualPayment(companyId: number, dto: ManualPaymentDto, user: AuthenticatedUser) {
    const [company] = await this.dataSource.query(`SELECT id FROM companies WHERE id = $1`, [companyId]);
    if (!company) throw new NotFoundException('Company not found.');
    const [pkg] = dto.package_id ? await this.dataSource.query(`SELECT name FROM platform_package WHERE id = $1`, [dto.package_id]) : [];
    const [pack] = dto.token_pack_id ? await this.dataSource.query(`SELECT name FROM token_pack WHERE id = $1`, [dto.token_pack_id]) : [];
    if (dto.kind === 'subscription' && !pkg) throw new BadRequestException('Choose a package.');
    if (dto.kind === 'token_pack' && !pack) throw new BadRequestException('Choose a credit pack.');
    const description = dto.kind === 'subscription'
      ? `${pkg.name} package – ${dto.billing_cycle === 'yearly' ? '1 year' : '1 month'} (recorded by Agent Metra)`
      : `${pack.name} (recorded by Agent Metra)`;
    const [row] = await this.dataSource.query(`
      INSERT INTO platform_payment (company_id, kind, package_id, billing_cycle, token_pack_id, description, amount, method, status, order_id, note, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', 'pending', $8, $9, $10) RETURNING id`,
      [companyId, dto.kind, dto.package_id ?? null, dto.kind === 'subscription' ? dto.billing_cycle ?? 'monthly' : null, dto.token_pack_id ?? null,
        description, dto.amount, `AMM${companyId}-${Date.now().toString(36).toUpperCase()}`, dto.note ?? '', user.id]);
    return this.billing.approve(Number(row.id), user);
  }

  async exportCsv(kind: 'companies' | 'payments') {
    if (kind === 'payments') {
      return csv(await this.dataSource.query(`
        SELECT p.id, p.created_at, p.paid_at, c.company_name AS company, p.description, p.amount, p.currency, p.method, p.status, p.invoice_no, p.order_id
          FROM platform_payment p LEFT JOIN companies c ON c.id = p.company_id ORDER BY p.id DESC`));
    }
    return csv(await this.dataSource.query(`
      SELECT c.id, c.company_name AS company, c.email, c.phone, c.business_category, c.plan, s.billing_cycle, s.status, s.period_end, s.auto_renew, c.created_at
        FROM companies c LEFT JOIN company_subscription s ON s.company_id = c.id ORDER BY c.id`));
  }

  auditLog() {
    return this.dataSource.query(`SELECT * FROM platform_audit_log ORDER BY id DESC LIMIT 300`);
  }

  superAdmins() {
    return this.dataSource.query(`SELECT id, name, email, is_active FROM app_user WHERE is_super_admin = TRUE ORDER BY id`);
  }

  async addSuperAdmin(email: string) {
    const [user] = await this.dataSource.query(`SELECT id FROM app_user WHERE LOWER(email) = LOWER($1)`, [email.trim()]);
    if (!user) throw new NotFoundException('No account with this email – the person must register first.');
    await this.dataSource.query(`UPDATE app_user SET is_super_admin = TRUE WHERE id = $1`, [user.id]);
    this.auth.invalidateAccount(Number(user.id));
    return this.superAdmins();
  }

  async removeSuperAdmin(id: number, me: AuthenticatedUser) {
    if (Number(id) === Number(me.id)) throw new BadRequestException('You cannot remove yourself.');
    const admins = await this.superAdmins();
    if (admins.length <= 1) throw new BadRequestException('At least one super admin must remain.');
    await this.dataSource.query(`UPDATE app_user SET is_super_admin = FALSE WHERE id = $1`, [id]);
    this.auth.invalidateAccount(Number(id));
    return this.superAdmins();
  }

  async systemHealth() {
    const botUrl = String(process.env.SALES_BOT_URL ?? '').trim().replace(/\/+$/, '');
    let bot = { ok: false, detail: 'SALES_BOT_URL not set' };
    if (botUrl) {
      const started = Date.now();
      try {
        const response = await fetch(`${botUrl}/health`, { signal: AbortSignal.timeout(5000) });
        bot = { ok: response.ok, detail: `${response.status} in ${Date.now() - started} ms` };
      } catch (error) {
        bot = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    const [stats] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS replies_24h, COALESCE(AVG(latency_ms), 0)::int AS avg_latency_ms,
             COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms,
             COALESCE(SUM(cached_tokens)::float / NULLIF(SUM(input_tokens), 0), 0) AS cache_ratio
        FROM bot_ai_usage WHERE created_at > NOW() - INTERVAL '24 hours'`);
    const [errors] = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM bot_notification WHERE kind = 'handoff' AND title LIKE 'Bot could not reply%' AND created_at > NOW() - INTERVAL '24 hours'`).catch(() => [{ n: 0 }]);
    const set = (name: string) => Boolean(String(process.env[name] ?? '').trim());
    return {
      sales_bot: bot,
      database: { ok: true },
      last_24h: { replies: num(stats?.replies_24h), avg_latency_ms: num(stats?.avg_latency_ms), p95_latency_ms: num(stats?.p95_latency_ms), cache_ratio: num(stats?.cache_ratio), bot_errors: num(errors?.n) },
      config: {
        public_api_url: set('PUBLIC_API_BASE_URL'), app_public_url: set('APP_PUBLIC_URL'), payhere: set('PAYHERE_MERCHANT_ID') && set('PAYHERE_MERCHANT_SECRET'),
        meta_app: set('META_APP_ID') && set('META_APP_SECRET'), email: set('SMTP_HOST'), whatsapp_otp: set('OTP_WHATSAPP_PHONE_NUMBER_ID') && set('OTP_WHATSAPP_TOKEN'),
        pusher: set('PUSHER_APP_ID'),
      },
    };
  }
}

@Controller('super-admin')
@ApiTags('Super admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@UseInterceptors(SuperAdminAuditInterceptor)
export class SuperAdminExtraController {
  constructor(private readonly service: SuperAdminExtraService) {}

  @Get('revenue')
  revenue(@Query() query: RevenueQueryDto) { return this.service.revenue(query.months); }

  @Get('companies/:id/360')
  company360(@Param('id', ParseIntPipe) id: number) { return this.service.company360(id); }

  @Patch('companies/:id/status')
  setStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: CompanyStatusDto) { return this.service.setCompanyStatus(id, dto.status); }

  @Get('announcements')
  announcements() { return this.service.announcements(); }

  @Post('announcements')
  announce(@Body() dto: AnnouncementDto, @CurrentUser() user: AuthenticatedUser) { return this.service.announce(dto, user); }

  @Post('companies/:id/manual-payment')
  manualPayment(@Param('id', ParseIntPipe) id: number, @Body() dto: ManualPaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.manualPayment(id, dto, user);
  }

  @Get('export/:kind')
  async export(@Param('kind') kind: string, @Res() res: Response) {
    if (kind !== 'companies' && kind !== 'payments') throw new BadRequestException('Unknown export.');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agent-metra-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await this.service.exportCsv(kind));
  }

  @Get('audit-log')
  auditLog() { return this.service.auditLog(); }

  @Get('admins')
  admins() { return this.service.superAdmins(); }

  @Post('admins')
  addAdmin(@Body() dto: AddSuperAdminDto) { return this.service.addSuperAdmin(dto.email); }

  @Delete('admins/:id')
  removeAdmin(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthenticatedUser) { return this.service.removeSuperAdmin(id, user); }

  @Get('system')
  system() { return this.service.systemHealth(); }
}
