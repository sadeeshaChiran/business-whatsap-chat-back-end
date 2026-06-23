import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { WhatsappChannel } from '../../whatsapp/entities/whatsapp-channel.entity';
import { WhatsappModule } from '../../whatsapp/whatsapp.module';
import { EvolutionAdapter } from './adapters/evolution.adapter';
import { MetaAdapter } from './adapters/meta.adapter';
import {
  WhatsappProviderFactory,
  WhatsappRoutingService,
} from './whatsapp-provider.factory';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [AuthModule, WhatsappModule, TypeOrmModule.forFeature([WhatsappChannel])],
  controllers: [WhatsappWebhookController],
  providers: [
    EvolutionAdapter,
    MetaAdapter,
    WhatsappProviderFactory,
    WhatsappRoutingService,
    WhatsappService,
  ],
  exports: [WhatsappService, WhatsappProviderFactory],
})
export class WhatsappIntegrationModule {}
