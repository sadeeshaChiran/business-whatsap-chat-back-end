import { SuperAdminAuditInterceptor } from './audit.interceptor';
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreditSettingsDto, ListQueryDto, PackageDto, TokenAdjustmentDto, UpdatePackageDto, UpdateSubscriptionDto } from './dto/platform.dto';
import { PlanService } from './plan.service';
import { SuperAdminGuard } from './super-admin.guard';
import { SuperAdminService } from './super-admin.service';
import { TokenQuotaService } from './token-quota.service';

/** Metrocoding team only. */
@Controller('super-admin')
@ApiTags('Super admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@UseInterceptors(SuperAdminAuditInterceptor)
export class SuperAdminController {
  constructor(private readonly service: SuperAdminService) {}

  @Get('overview')
  overview() { return this.service.overview(); }

  @Get('companies')
  companies(@Query() query: ListQueryDto) { return this.service.companies(query); }

  @Get('companies/:id')
  company(@Param('id', ParseIntPipe) id: number) { return this.service.company(id); }

  @Patch('companies/:id/subscription')
  updateSubscription(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSubscriptionDto) {
    return this.service.updateSubscription(id, dto);
  }

  @Post('companies/:id/token-adjustments')
  addAdjustment(@Param('id', ParseIntPipe) id: number, @Body() dto: TokenAdjustmentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.addAdjustment(id, dto, user);
  }

  @Get('packages')
  packages() { return this.service.listPackages(); }

  @Post('packages')
  createPackage(@Body() dto: PackageDto) { return this.service.createPackage(dto); }

  @Patch('packages/:id')
  updatePackage(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePackageDto) { return this.service.updatePackage(id, dto); }

  @Get('usage')
  usage(@Query() query: ListQueryDto) { return this.service.usage(query.days); }

  @Get('credit-settings')
  creditSettings() { return this.service.creditSettings(); }

  @Put('credit-settings')
  setCreditSettings(@Body() dto: CreditSettingsDto) { return this.service.setCreditSettings(dto.tokens_per_credit); }
}

/** For every signed-in company user: token usage WITHOUT any cost. */
@Controller('billing')
@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(private readonly quota: TokenQuotaService) {}

  @Get('usage')
  usage(@CurrentUser() user: AuthenticatedUser) {
    return this.quota.usage(Number(user.company_id));
  }
}

/** Public (no login): packages for the pricing page. */
@Controller('public/packages')
@ApiTags('Public')
export class PublicPackagesController {
  constructor(private readonly planService: PlanService) {}

  @Get()
  async list() {
    const tpc = await this.planService.tokensPerCredit();
    return (await this.planService.packages())
      .filter((pkg) => pkg.is_active && pkg.is_public)
      .map((pkg) => ({
        code: pkg.code, name: pkg.name, description: pkg.description, price_monthly: Number(pkg.price_monthly),
        price_yearly: Number(pkg.price_yearly), tokens_per_month: Number(pkg.tokens_per_month),
        credits_per_month: PlanService.credits(Number(pkg.tokens_per_month), tpc),
        max_agents: pkg.max_agents, max_products: pkg.max_products, features: pkg.features ?? [],
      }));
  }
}
