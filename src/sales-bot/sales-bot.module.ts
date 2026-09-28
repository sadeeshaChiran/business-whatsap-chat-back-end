import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentRoutingModule } from '../agent-routing/agent-routing.module';
import { AuthModule } from '../auth/auth.module';
import { BotChannelUser } from '../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { BotCustomerNote } from '../bot-admin/entities/bot-customer-note.entity';
import { BotMessage } from '../bot-admin/entities/bot-message.entity';
import { BotOrderItem } from '../bot-admin/entities/bot-order-item.entity';
import { BotOrderStatusHistory } from '../bot-admin/entities/bot-order-status-history.entity';
import { BotOrder } from '../bot-admin/entities/bot-order.entity';
import { BotTrainingData } from '../bot-admin/entities/bot-training-data.entity';
import { PusherService } from '../common/pusher.service';
import { MetaSocialSenderService } from '../integrations/meta/meta-social-sender.service';
import { MetaPageConnection } from '../meta/entities/meta-page-connection.entity';
import { Company } from '../company/entities/company.entity';
import { WhatsappIntegrationModule } from '../integrations/whatsapp/whatsapp.module';
import { ProductVariant } from '../products/entities/product-variant.entity';
import { Product } from '../products/entities/product.entity';
import { BotAdminModule } from '../bot-admin/bot-admin.module';
import { BotAiUsage } from './entities/bot-ai-usage.entity';
import { BotNotification } from './entities/bot-notification.entity';
import { BotBooking } from './entities/bot-booking.entity';
import { BotDeliveryZone } from './entities/bot-delivery-zone.entity';
import { BotService } from './entities/bot-service.entity';
import { SalesBotSettings } from './entities/sales-bot-settings.entity';
import { SalesBotAdminService } from './sales-bot-admin.service';
import { SalesBotClient } from './sales-bot.client';
import { SalesBotContextService } from './sales-bot-context.service';
import { SalesBotController } from './sales-bot.controller';
import { SalesBotEngineService } from './sales-bot-engine.service';

/**
 * Python sales bot integration: replaces the n8n AI workflow when SALES_BOT_URL is set.
 * Without SALES_BOT_URL nothing changes (n8n keeps working).
 */
@Module({
  imports: [
    AuthModule,
    AgentRoutingModule,
    WhatsappIntegrationModule,
    BotAdminModule,
    TypeOrmModule.forFeature([
      Company, BotChannelUser, BotConversation, BotMessage, BotOrder, BotOrderItem, BotOrderStatusHistory,
      BotCustomerNote, BotTrainingData, Product, ProductVariant,
      SalesBotSettings, BotService, BotDeliveryZone, BotBooking, BotAiUsage, BotNotification, MetaPageConnection,
    ]),
  ],
  controllers: [SalesBotController],
  providers: [SalesBotClient, SalesBotContextService, SalesBotEngineService, SalesBotAdminService, PusherService, MetaSocialSenderService],
})
export class SalesBotModule {}
