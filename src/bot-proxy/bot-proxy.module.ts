import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BotProxyController } from './bot-proxy.controller';
import { BotProxyService } from './bot-proxy.service';

@Module({
  imports: [AuthModule],
  controllers: [BotProxyController],
  providers: [BotProxyService],
  exports: [BotProxyService],
})
export class BotProxyModule {}
