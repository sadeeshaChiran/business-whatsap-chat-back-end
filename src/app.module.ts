import { DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import {
  getSupabaseDatabaseUrl,
  SUPABASE_DATA_SOURCE,
} from './common/supabase-database';
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
import { CustomersModule } from './customers/customers.module';
import { SupabaseModule } from './supabase/supabase.module';
import { getEnvNumber, getEnvValue } from './common/env';
import { Product } from './products/entities/product.entity';
import { ProductVariant } from './products/entities/product-variant.entity';
import { ProductCatergory } from './products/product_catergory/entities/product_catergory.entity';
import { SupabaseCompany } from './supabase/entities/supabase-company.entity';
import { SupabaseCustomer } from './supabase/entities/supabase-customer.entity';

const supabaseDatabaseUrl = getSupabaseDatabaseUrl();

const databaseImports = [
  TypeOrmModule.forRoot({
    type: 'mysql',
    host: getEnvValue('MYSQL_HOST', 'localhost'),
    port: getEnvNumber('MYSQL_PORT', 3306),
    username: getEnvValue('MYSQL_USER', 'root'),
    password: getEnvValue('MYSQL_PASSWORD', '', { allowEmpty: true }),
    database: getEnvValue('MYSQL_DATABASE', 'business_health_scanner_db'),
    autoLoadEntities: true,
    synchronize: true,
  }),
];

const supabaseModules: Array<DynamicModule | typeof CustomersModule> = [];

if (supabaseDatabaseUrl && SUPABASE_DATA_SOURCE) {
  databaseImports.push(
    TypeOrmModule.forRoot({
      name: SUPABASE_DATA_SOURCE,
      type: 'postgres',
      url: supabaseDatabaseUrl,
      entities: [
        Product,
        ProductVariant,
        ProductCatergory,
        SupabaseCompany,
        SupabaseCustomer,
      ],
      synchronize: false,
      ssl: { rejectUnauthorized: false },
    }),
  );
  supabaseModules.push(SupabaseModule.register(), CustomersModule);
}

@Module({
  imports: [
    ...databaseImports,
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
