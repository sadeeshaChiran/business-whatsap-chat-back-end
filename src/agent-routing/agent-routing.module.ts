import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotChannelUser } from '../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../bot-admin/entities/bot-message.entity';
import { Company } from '../company/entities/company.entity';
import { PusherService } from '../common/pusher.service';
import { SupabaseCustomer } from '../supabase/entities/supabase-customer.entity';
import { User } from '../users/entities/user.entity';
import { AgentRoutingScheduler } from './agent-routing.scheduler';
import { AgentRoutingService } from './agent-routing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Company,
      BotConversation,
      BotChannelUser,
      BotMessage,
      SupabaseCustomer,
    ]),
  ],
  providers: [AgentRoutingService, AgentRoutingScheduler, PusherService],
  exports: [AgentRoutingService],
})
export class AgentRoutingModule {}
