import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Company } from '../company/entities/company.entity';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';
import { AgentRoutingModule } from '../agent-routing/agent-routing.module';
import { PusherService } from '../common/pusher.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Company, BotConversation]),
    AuthModule,
    AgentRoutingModule,
  ],
  providers: [UsersService, PusherService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
