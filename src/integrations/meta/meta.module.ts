import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { CompanyModule } from '../../company/company.module';
import { Company } from '../../company/entities/company.entity';
import { MetaOauthPending } from '../../meta/entities/meta-oauth-pending.entity';
import { MetaPageConnection } from '../../meta/entities/meta-page-connection.entity';
import { MetaPageConnectionService } from '../../meta/meta-page-connection.service';
import { MetaController } from './meta.controller';
import { MetaGraphService } from './meta-graph.service';
import { MetaOAuthController } from './meta-oauth.controller';
import { MetaMessagesController } from './meta-messages.controller';
import { BotChannelUser } from '../../bot-admin/entities/bot-channel-user.entity';
import { BotConversation } from '../../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../../bot-admin/entities/bot-message.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Company,
      MetaPageConnection,
      MetaOauthPending,
      BotChannelUser,
      BotConversation,
      BotMessage,
    ]),
    AuthModule,
    CompanyModule,
  ],
  controllers: [MetaController, MetaOAuthController, MetaMessagesController],
  providers: [MetaGraphService, MetaPageConnectionService],
  exports: [MetaPageConnectionService, MetaGraphService],
})
export class MetaModule {}
