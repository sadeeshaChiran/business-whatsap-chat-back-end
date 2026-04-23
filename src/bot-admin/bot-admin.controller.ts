import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BotAdminService } from './bot-admin.service';
import { CreateBotTrainingDto } from './dto/create-bot-training.dto';
import { BotFlagsQueryDto } from './dto/bot-flags-query.dto';
import { BotUsersQueryDto } from './dto/bot-users-query.dto';
import { ToggleBotUserDto } from './dto/toggle-bot-user.dto';

@Controller('bot')
@ApiTags('Bot Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class BotAdminController {
  constructor(private readonly botAdminService: BotAdminService) {}

  @Get('users')
  getUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BotUsersQueryDto,
  ) {
    return this.botAdminService.getUsers(user, query);
  }

  @Post('user/:id/toggle')
  toggleUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() payload: ToggleBotUserDto,
  ) {
    return this.botAdminService.toggleUser(user, Number(id), payload);
  }

  @Get('flags')
  getFlags(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BotFlagsQueryDto,
  ) {
    return this.botAdminService.getFlags(user, query);
  }

  @Get('conversations/:id')
  getConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.botAdminService.getConversation(user, Number(id));
  }

  @Post('train')
  train(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: CreateBotTrainingDto,
  ) {
    return this.botAdminService.createTraining(user, payload);
  }
}
