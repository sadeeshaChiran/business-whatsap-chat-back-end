import { FeatureGuard } from './feature.guard';
import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { Company } from '../company/entities/company.entity';
import { User } from '../users/entities/user.entity';
import { CompanySubscription } from './entities/company-subscription.entity';
import { PlatformPackage } from './entities/platform-package.entity';
import { TokenAdjustment } from './entities/token-adjustment.entity';
import { PlatformPayment } from './entities/platform-payment.entity';
import { PlatformSetting } from './entities/platform-setting.entity';
import { TokenPack } from './entities/token-pack.entity';
import { CompanyBillingController, PayhereNotifyController, SuperAdminBillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { SuperAdminExtraController, SuperAdminExtraService } from './super-admin-extra';
import { PublicBrandingController, SuperAdminBrandingController } from './branding';
import { BrandingService } from './branding.service';
import { SuperAdminAuditInterceptor } from './audit.interceptor';
import { BillingController, PublicPackagesController, SuperAdminController } from './platform.controller';
import { PlanService } from './plan.service';
import { SuperAdminGuard } from './super-admin.guard';
import { SuperAdminService } from './super-admin.service';
import { TokenQuotaService } from './token-quota.service';

/**
 * Agent Metra platform: packages, subscriptions, token quotas and the super admin area.
 * Global so every module can use PlanService / TokenQuotaService.
 */
@Global()
@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([PlatformPackage, CompanySubscription, TokenAdjustment, PlatformPayment, PlatformSetting, TokenPack, Company, User])],
  controllers: [SuperAdminController, BillingController, PublicPackagesController, CompanyBillingController, PayhereNotifyController, SuperAdminBillingController, SuperAdminExtraController, PublicBrandingController, SuperAdminBrandingController],
  providers: [FeatureGuard, PlanService, TokenQuotaService, SuperAdminService, SuperAdminGuard, BillingService, SuperAdminExtraService, SuperAdminAuditInterceptor, BrandingService],
  exports: [PlanService, TokenQuotaService, FeatureGuard, BrandingService],
})
export class PlatformModule implements OnModuleInit {
  private readonly logger = new Logger(PlatformModule.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** SUPER_ADMIN_EMAILS=a@metrocoding.lk,b@metrocoding.lk → these accounts become super admins. */
  async onModuleInit() {
    const emails = String(process.env.SUPER_ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return;
    try {
      const result = await this.dataSource.query(
        `UPDATE app_user SET is_super_admin = TRUE WHERE LOWER(email) = ANY($1) AND is_super_admin = FALSE`, [emails]);
      this.logger.log(`super admins from SUPER_ADMIN_EMAILS: ${emails.join(', ')} (${Array.isArray(result) ? result[1] ?? 0 : 0} updated)`);
    } catch (error) {
      this.logger.warn(`could not set super admins: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
