import { DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { getSupabaseDatabaseUrl } from './common/supabase-database';
import { AuthModule } from './auth/auth.module';
import { ExpensesModule } from './expenses/expenses.module';
import { IncomeModule } from './income/income.module';
import { CompanyModule } from './company/company.module';
import { NotesModule } from './notes/notes.module';
import { NoteColorTagsModule } from './notes/color_tags/color_tags.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { ProductsModule } from './products/products.module';
import { BotAdminModule } from './bot-admin/bot-admin.module';
import { BotProxyModule } from './bot-proxy/bot-proxy.module';
import { CustomersModule } from './customers/customers.module';
import { SupabaseModule } from './supabase/supabase.module';
import { EvolutionModule } from './integrations/evolution/evolution.module';
import { MetaModule } from './integrations/meta/meta.module';
import { UsersModule } from './users/users.module';

const supabaseDatabaseUrl = getSupabaseDatabaseUrl();
if (!supabaseDatabaseUrl) {
  throw new Error('PRODUCT_DATABASE_URL (or SUPABASE_DATABASE_URL) is required');
}

const supabaseModules: Array<DynamicModule | typeof CustomersModule> = [
  SupabaseModule,
  CustomersModule,
];

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: supabaseDatabaseUrl,
      autoLoadEntities: true,
      synchronize: false,
      ssl: { rejectUnauthorized: false },
    }),
    ...supabaseModules,
    AuthModule,
    ExpensesModule,
    IncomeModule,
    CompanyModule,
    NotesModule,
    NoteColorTagsModule,
    NotificationsModule,
    ReportsModule,
    ProductsModule,
    BotAdminModule,
    BotProxyModule,
    EvolutionModule,
    MetaModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
  ],
})
export class AppModule {}
