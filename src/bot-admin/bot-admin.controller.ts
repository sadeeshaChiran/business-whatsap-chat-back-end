import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
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

  @Get('stats')
  getStats(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.getStats(user);
  }

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

  @Get('conversations')
  getConversations(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.getConversations(user);
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

  @Post('train/upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        category: { type: 'string' },
      },
    },
  })
  uploadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: any,
    @Body('category') category?: string,
  ) {
    return this.botAdminService.uploadTrainingFile(user, file, category);
  }

  @Get('train/history')
  getTrainingHistory(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.getTrainingHistory(user);
  }
}
