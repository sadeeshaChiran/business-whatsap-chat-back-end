import { DynamicModule, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SUPABASE_DATA_SOURCE } from '../common/supabase-database';
import { SupabaseCompany } from './entities/supabase-company.entity';
import { SupabaseCustomer } from './entities/supabase-customer.entity';
import { SupabaseCompanyService } from './supabase-company.service';

@Global()
@Module({})
export class SupabaseModule {
  static register(): DynamicModule {
    if (!SUPABASE_DATA_SOURCE) {
      return {
        module: SupabaseModule,
        providers: [],
        exports: [],
      };
    }

    return {
      module: SupabaseModule,
      imports: [
        TypeOrmModule.forFeature(
          [SupabaseCompany, SupabaseCustomer],
          SUPABASE_DATA_SOURCE,
        ),
      ],
      providers: [SupabaseCompanyService],
      exports: [SupabaseCompanyService, TypeOrmModule],
    };
  }
}
