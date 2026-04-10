import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { CompanyService } from './company.service';
import { CompanyController } from './company.controller';
import { IndustryModule } from './industry/industry.module';
import { Company } from './entities/company.entity';
import { Industry } from './industry/entities/industry.entity';

@Module({
  controllers: [CompanyController],
  providers: [CompanyService],
  imports: [
    TypeOrmModule.forFeature([Company, Industry]),
    IndustryModule,
    AuthModule,
  ],
})
export class CompanyModule {}
