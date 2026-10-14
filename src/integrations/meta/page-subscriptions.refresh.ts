import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetaPageConnection } from '../../meta/entities/meta-page-connection.entity';
import { MetaGraphService, PAGE_FIELDS } from './meta-graph.service';

/**
 * Pages connected before ad clicks were subscribed ("messaging_referrals") never told us which ad a Messenger /
 * Instagram customer came from. Shortly after every start, each connected Page that misses a field is subscribed again
 * (once, quietly). Nothing changes for Pages that already have every field.
 */
@Injectable()
export class PageSubscriptionsRefresh implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PageSubscriptionsRefresh.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(MetaPageConnection) private readonly pages: Repository<MetaPageConnection>,
    private readonly graph: MetaGraphService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.META_PAGE_RESUBSCRIBE === 'false' || !process.env.META_APP_ID?.trim()) return;
    this.timer = setTimeout(() => void this.run().catch((error) => this.logger.warn(`page re-subscribe skipped: ${String(error)}`)), 20_000);
    this.timer.unref?.();
  }

  onModuleDestroy() { if (this.timer) clearTimeout(this.timer); }

  async run(): Promise<{ checked: number; fixed: number }> {
    const rows = await this.pages.find({ where: { status: 'CONNECTED' } });
    let fixed = 0;
    for (const page of rows) {
      if (!page.page_id || !page.page_access_token) continue;
      const fields = await this.graph.pageSubscribedFields(page.page_id, page.page_access_token).catch(() => null);
      if (!fields || PAGE_FIELDS.every((f) => fields.includes(f))) continue;
      try {
        await this.graph.subscribePageMessaging(page.page_id, page.page_access_token);
        fixed++;
      } catch (error) {
        this.logger.warn(`page ${page.page_id} (company ${page.company_id}): could not subscribe – ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (fixed) this.logger.log(`subscribed ${fixed} of ${rows.length} Page(s) to the missing webhook fields (ad clicks)`);
    return { checked: rows.length, fixed };
  }
}
