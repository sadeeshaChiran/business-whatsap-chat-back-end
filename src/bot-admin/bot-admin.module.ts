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
import { BotTrainingData } from './entities/bot-training-data.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Company,
      BotChannelUser,
      BotConversation,
      BotMessage,
      BotTrainingData,
      BotFlag,
    ]),
    AuthModule,
  ],
  controllers: [BotAdminController],
  providers: [BotAdminService],
})
export class BotAdminModule {}
