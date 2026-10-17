import { Controller, Get, Global, Injectable, Logger, Module, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ManagerOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AuthModule } from '../auth/auth.module';

export type ActivityEntry = {
  action: 'order_status' | 'order_edit' | 'order_note' | 'order_delete' | 'order_invoice' | 'lead_stage' | 'team_role' | string;
  entity: 'order' | 'conversation' | 'agent' | string;
  entity_id?: number | null;
  summary: string;
  details?: Record<string, unknown> | null;
};

/**
 * Company activity log: who changed or deleted what (orders, pipeline stage, team roles).
 * The owner and supervisors see it under Team → Activity log. Writing never breaks the real action.
 */
@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async log(user: AuthenticatedUser, entry: ActivityEntry) {
    try {
      await this.db.query(
        `INSERT INTO company_activity_log (company_id, user_id, user_name, user_role, action, entity, entity_id, summary, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [Number(user.company_id), Number(user.id) || null, user.name ?? null, user.role ?? null, entry.action, entry.entity,
          entry.entity_id ?? null, entry.summary.slice(0, 2000), entry.details ? JSON.stringify(entry.details) : null],
      );
    } catch (error) {
      this.logger.warn(`Activity log not written: ${(error as Error).message}`);
    }
  }

  async list(companyId: number, query: { page?: string; limit?: string; entity?: string; action?: string }) {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const page = Math.max(Number(query.page) || 1, 1);
    const entity = query.entity ? String(query.entity).slice(0, 40) : null;
    const action = query.action ? String(query.action).slice(0, 40) : null;
    const where = `company_id = $1 AND ($2::text IS NULL OR entity = $2) AND ($3::text IS NULL OR action = $3)`;
    const items = await this.db.query(
      `SELECT id, user_id, user_name, user_role, action, entity, entity_id, summary, details, created_at
         FROM company_activity_log WHERE ${where} ORDER BY id DESC LIMIT $4 OFFSET $5`,
      [companyId, entity, action, limit, (page - 1) * limit],
    );
    const [{ total }] = await this.db.query(`SELECT COUNT(*)::int AS total FROM company_activity_log WHERE ${where}`, [companyId, entity, action]);
    return { items, total, page, limit };
  }
}

@Controller('activity-log')
@ApiTags('Activity log')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class ActivityLogController {
  constructor(private readonly service: ActivityLogService) {}

  @Get()
  @ManagerOnly()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: { page?: string; limit?: string; entity?: string; action?: string }) {
    return this.service.list(Number(user.company_id), query);
  }
}

@Global()
@Module({ imports: [AuthModule], controllers: [ActivityLogController], providers: [ActivityLogService], exports: [ActivityLogService] })
export class ActivityLogModule {}
