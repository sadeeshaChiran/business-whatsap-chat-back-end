import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Put, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SuperAdminAuditInterceptor } from './audit.interceptor';
import { PlanService } from './plan.service';
import { SuperAdminGuard } from './super-admin.guard';

type Row = Record<string, any>;
const DESCRIPTION: Record<string, string> = {
  sms: 'SMS credits, SMS campaigns and "Send SMS" from a chat.',
  customer_app: 'The free chat app for customers – the app link, app customers, broadcasts, groups, meetings and news.',
};

/** Super admin: hidden features (SMS, Customer app) – switched on per company. Everybody else does not see them. */
@Controller('super-admin')
@ApiTags('Super admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@UseInterceptors(SuperAdminAuditInterceptor)
export class SuperAdminFeatureAccessController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly plan: PlanService) {}

  /** Every hidden feature and the companies it is switched on for. */
  @Get('hidden-features')
  async overview() {
    const rows: Row[] = await this.dataSource.query(`
      SELECT a.feature, a.company_id, c.company_name AS name, a.note, a.created_at
        FROM company_feature_access a JOIN companies c ON c.id = a.company_id ORDER BY a.created_at DESC`);
    return Object.entries(PlanService.HIDDEN_FEATURES).map(([key, label]) => ({
      key, label, description: DESCRIPTION[key] ?? '',
      companies: rows.filter((r) => r.feature === key).map((r) => ({ id: Number(r.company_id), name: r.name, note: r.note ?? null, since: r.created_at })),
    }));
  }

  @Get('companies/:id/hidden-features')
  company(@Param('id', ParseIntPipe) id: number) { return this.list(id); }

  @Put('companies/:id/hidden-features/:key')
  async set(@Param('id', ParseIntPipe) id: number, @Param('key') key: string, @Body() body: { on?: boolean; note?: string | null }, @CurrentUser() user: AuthenticatedUser) {
    if (!(key in PlanService.HIDDEN_FEATURES)) throw new BadRequestException('Unknown feature.');
    const [company] = await this.dataSource.query(`SELECT id FROM companies WHERE id = $1`, [id]);
    if (!company) throw new NotFoundException('Company not found.');
    if (body?.on === true) {
      const note = String(body.note ?? '').trim().slice(0, 200) || null;
      await this.dataSource.query(`
        INSERT INTO company_feature_access (company_id, feature, note, created_by) VALUES ($1, $2, $3, $4)
        ON CONFLICT (company_id, feature) DO UPDATE SET note = COALESCE(EXCLUDED.note, company_feature_access.note)`, [id, key, note, Number(user.id) || null]);
    } else if (body?.on === false) {
      await this.dataSource.query(`DELETE FROM company_feature_access WHERE company_id = $1 AND feature = $2`, [id, key]);
      // switched off = really off: the app link stops working, SMS still sending stop
      if (key === 'customer_app') await this.dataSource.query(`UPDATE ca_settings SET enabled = FALSE, updated_at = NOW() WHERE company_id = $1`, [id]);
      if (key === 'sms') {
        await this.dataSource.query(`
          UPDATE sms_message SET status = 'skipped', error = 'Stopped' WHERE status = 'queued'
             AND campaign_id IN (SELECT id FROM sms_campaign WHERE company_id = $1 AND status = 'sending')`, [id]);
        await this.dataSource.query(`UPDATE sms_campaign SET status = 'stopped', finished_at = NOW() WHERE company_id = $1 AND status = 'sending'`, [id]);
      }
    } else throw new BadRequestException('Send on: true or false.');
    this.plan.forgetCompany(id);
    return this.list(id);
  }

  private async list(id: number) {
    const rows: Row[] = await this.dataSource.query(`SELECT feature, note, created_at FROM company_feature_access WHERE company_id = $1`, [id]);
    return Object.entries(PlanService.HIDDEN_FEATURES).map(([key, label]) => {
      const row = rows.find((r) => r.feature === key);
      return { key, label, description: DESCRIPTION[key] ?? '', on: Boolean(row), note: row?.note ?? null, since: row?.created_at ?? null };
    });
  }
}
