import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../company/entities/company.entity';
import { WhatsappChannel } from './entities/whatsapp-channel.entity';
import { WhatsappChannelService } from './whatsapp-channel.service';

@Module({
  imports: [TypeOrmModule.forFeature([WhatsappChannel, Company])],
  providers: [WhatsappChannelService],
  exports: [WhatsappChannelService, TypeOrmModule],
})
export class WhatsappModule {}
