import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Company } from '../company/entities/company.entity';
import { BotAdminController } from './bot-admin.controller';
import { BotAdminService } from './bot-admin.service';
import { BotChannelUser } from './entities/bot-channel-user.entity';
import { BotConversation } from './entities/bot-conversation.entity';
import { BotFlag } from './entities/bot-flag.entity';
import { BotMessage } from './entities/bot-message.entity';
import { BotOrderItem } from './entities/bot-order-item.entity';
import { BotOrderStatusHistory } from './entities/bot-order-status-history.entity';
import { BotOrderStatusTemplate } from './entities/bot-order-status-template.entity';
import { BotOrder } from './entities/bot-order.entity';
import { BotTrainingData } from './entities/bot-training-data.entity';
import { SupabaseCustomer } from '../supabase/entities/supabase-customer.entity';
import { WhatsappChannel } from '../whatsapp/entities/whatsapp-channel.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Company,
      SupabaseCustomer,
      WhatsappChannel,
      BotChannelUser,
      BotConversation,
      BotMessage,
      BotTrainingData,
      BotFlag,
      BotOrder,
      BotOrderItem,
      BotOrderStatusHistory,
      BotOrderStatusTemplate,
    ]),
    AuthModule,
  ],
  controllers: [BotAdminController],
  providers: [BotAdminService],
})
export class BotAdminModule {}
