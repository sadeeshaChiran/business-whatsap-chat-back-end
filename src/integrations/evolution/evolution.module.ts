import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { CompanyModule } from '../../company/company.module';
import { Company } from '../../company/entities/company.entity';
import { WhatsappModule } from '../../whatsapp/whatsapp.module';
import { EvolutionController } from './evolution.controller';
import { EvolutionService } from './evolution.service';

@Module({
  imports: [TypeOrmModule.forFeature([Company]), AuthModule, WhatsappModule, CompanyModule],
  controllers: [EvolutionController],
  providers: [EvolutionService],
  exports: [EvolutionService],
})
export class EvolutionModule {}

