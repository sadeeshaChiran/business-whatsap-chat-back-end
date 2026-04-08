import { Module } from '@nestjs/common';
import { CompanyService } from './company.service';
import { CompanyController } from './company.controller';
import { IndustryModule } from './industry/industry.module';

@Module({
  controllers: [CompanyController],
  providers: [CompanyService],
  imports: [IndustryModule],
})
export class CompanyModule {}
