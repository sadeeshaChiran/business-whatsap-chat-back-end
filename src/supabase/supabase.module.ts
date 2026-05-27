import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupabaseCustomer } from './entities/supabase-customer.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SupabaseCustomer])],
  exports: [TypeOrmModule],
})
export class SupabaseModule {}
