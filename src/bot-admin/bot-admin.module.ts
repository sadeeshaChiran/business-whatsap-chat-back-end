import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Company } from '../company/entities/company.entity';
import { User } from '../users/entities/user.entity';
import { PusherService } from '../common/pusher.service';
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
import { EvolutionModule } from '../integrations/evolution/evolution.module';
import { AgentRoutingModule } from '../agent-routing/agent-routing.module';

@Module({
  imports: [
    AgentRoutingModule,
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
      User,
    ]),
    AuthModule,
    EvolutionModule,
  ],
  controllers: [BotAdminController],
  providers: [BotAdminService, PusherService],
})
export class BotAdminModule {}
