import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndustryService } from './industry.service';
import { IndustryController } from './industry.controller';
import { Industry } from './entities/industry.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Industry])],
  controllers: [IndustryController],
  providers: [IndustryService],
})
export class IndustryModule {}
