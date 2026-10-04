import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { getDatabaseSsl, getSupabaseDatabaseUrl } from './common/supabase-database';
import { AuthModule } from './auth/auth.module';
import { CompanyModule } from './company/company.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ProductsModule } from './products/products.module';
import { BotAdminModule } from './bot-admin/bot-admin.module';
import { SupabaseModule } from './supabase/supabase.module';
import { EvolutionModule } from './integrations/evolution/evolution.module';
import { MetaModule } from './integrations/meta/meta.module';
import { UsersModule } from './users/users.module';
import { WhatsappIntegrationModule } from './integrations/whatsapp/whatsapp.module';
import { AutomationModule } from './automation/automation.module';
import { SalesBotModule } from './sales-bot/sales-bot.module';
import { PlatformModule } from './platform/platform.module';
import { VerificationModule } from './verification/verification';
import { CrmModule } from './crm/crm';
import { MobileModule } from './mobile/mobile';
import { MarketingModule } from './marketing/marketing.controller';
import { SocialModule } from './social/social.controller';
import { RealtimeModule } from './realtime/realtime.controller';

const supabaseDatabaseUrl = getSupabaseDatabaseUrl();
if (!supabaseDatabaseUrl) {
  throw new Error('PRODUCT_DATABASE_URL (or SUPABASE_DATABASE_URL) is required');
}


@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: supabaseDatabaseUrl,
      autoLoadEntities: true,
      synchronize: false,
      ssl: getDatabaseSsl(),
      extra: { max: Number(process.env.DB_POOL_MAX ?? 15), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 },
    }),
    SupabaseModule,
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) }],
    }),
    AuthModule,
    CompanyModule,
    NotificationsModule,
    ProductsModule,
    BotAdminModule,
    EvolutionModule,
    MetaModule,
    WhatsappIntegrationModule,
    UsersModule,
    AutomationModule,
    PlatformModule,
    VerificationModule,
    CrmModule,
    MobileModule,
    MarketingModule,
    SocialModule,
    SalesBotModule,
    RealtimeModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
  ],
})
export class AppModule {}
