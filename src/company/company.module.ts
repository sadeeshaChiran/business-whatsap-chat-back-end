import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { CompanyService } from './company.service';
import { CompanyController } from './company.controller';
import { Company } from './entities/company.entity';
import { Industry } from './industry/entities/industry.entity';
import { WhatsappChannel } from '../whatsapp/entities/whatsapp-channel.entity';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MetaPageConnection } from '../meta/entities/meta-page-connection.entity';
import { User } from '../users/entities/user.entity';
import { IndustryModule } from './industry/industry.controller';

@Module({
  controllers: [CompanyController],
  providers: [CompanyService],
  imports: [
    TypeOrmModule.forFeature([Company, Industry, WhatsappChannel, MetaPageConnection, User]),
    AuthModule,
    WhatsappModule,
    IndustryModule,
  ],
  exports: [CompanyService, TypeOrmModule],
})
export class CompanyModule {}
