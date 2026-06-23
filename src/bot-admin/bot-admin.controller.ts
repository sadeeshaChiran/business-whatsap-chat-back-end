import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
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
import { BotUsersQueryDto } from './dto/bot-users-query.dto';
import { ToggleBotUserDto } from './dto/toggle-bot-user.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateStatusTemplateDto } from './dto/update-status-template.dto';
import { CreateBotOrderDto } from './dto/create-bot-order.dto';
import { SendConversationMessageDto } from './dto/send-conversation-message.dto';
import { AssignConversationDto } from './dto/assign-conversation.dto';

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

  @Get('conversations')
  getConversations(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.getConversations(user);
  }

  /** Admin: conversations waiting in the open/unassigned queue */
  @Get('conversations/unassigned')
  getUnassignedConversations(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.getUnassignedConversations(user);
  }

  /** Admin: manually assign an open conversation to an online agent */
  @Post('conversations/:id/assign')
  manualAssignConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() payload: AssignConversationDto,
  ) {
    return this.botAdminService.manualAssignConversation(
      user,
      id,
      payload.agent_id,
    );
  }

  @Get('conversations/evolution/messages')
  getEvolutionInboxMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Query('remoteJid') remoteJid: string,
  ) {
    return this.botAdminService.getEvolutionInboxMessages(user, remoteJid);
  }

  @Post('conversations/evolution/messages')
  sendEvolutionInboxMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: SendConversationMessageDto,
    @Query('remoteJid') remoteJid: string,
  ) {
    return this.botAdminService.sendEvolutionInboxMessage(
      user,
      remoteJid,
      payload.text,
    );
  }

  @Get('conversations/:id')
  getConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.botAdminService.getConversation(user, Number(id));
  }

  @Post('conversations/:id/messages')
  sendConversationMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() payload: SendConversationMessageDto,
  ) {
    return this.botAdminService.sendConversationMessage(user, id, payload.text);
  }

  /** Agent accepts their assigned pending conversation */
  @Post('conversations/:id/accept')
  acceptConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.botAdminService.acceptConversation(user, id);
  }

  /** Agent rejects their assigned pending conversation */
  @Post('conversations/:id/reject')
  rejectConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.botAdminService.rejectConversation(user, id);
  }

  /** Get only conversations assigned to the currently logged-in agent */
  @Get('agent/conversations')
  getAgentConversations(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.getAgentConversations(user);
  }

  /** Toggle logged-in agent online/offline */
  @Post('agent/status/toggle')
  toggleOwnStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.toggleOwnStatus(user);
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
    @Body('content') content?: string,
  ) {
    return this.botAdminService.uploadTrainingFile(user, file, category, content);
  }

  @Get('train/history')
  getTrainingHistory(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.getTrainingHistory(user);
  }

  @Delete('train/:id')
  deleteTraining(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.botAdminService.deleteTraining(user, id);
  }

  @Get('orders')
  getOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.getOrders(user);
  }

  @Post('orders')
  createOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: CreateBotOrderDto,
  ) {
    return this.botAdminService.createOrder(user, payload);
  }

  @Post('orders/:id/status')
  updateOrderStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() payload: UpdateOrderStatusDto,
  ) {
    return this.botAdminService.updateOrderStatus(user, Number(id), payload);
  }

  @Post('orders/:id/send-invoice')
  sendOrderInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.botAdminService.sendOrderInvoice(user, Number(id));
  }

  @Get('order-status-templates')
  getStatusTemplates(@CurrentUser() user: AuthenticatedUser) {
    return this.botAdminService.getStatusTemplates(user);
  }

  @Post('order-status-templates')
  updateStatusTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: UpdateStatusTemplateDto,
  ) {
    return this.botAdminService.updateStatusTemplate(user, payload);
  }
}
