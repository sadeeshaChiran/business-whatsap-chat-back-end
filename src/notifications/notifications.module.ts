import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotChannelUser } from '../bot-admin/entities/bot-channel-user.entity';
import { BotFlag } from '../bot-admin/entities/bot-flag.entity';
import { AuthModule } from '../auth/auth.module';
import { Expense } from '../expenses/entities/expense.entity';
import { Income } from '../income/entities/income.entity';
import { Note } from '../notes/entities/note.entity';
import { ReportsModule } from '../reports/reports.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Expense, Income, Note, BotFlag, BotChannelUser]),
    AuthModule,
    ReportsModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
