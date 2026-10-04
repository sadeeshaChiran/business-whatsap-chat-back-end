import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateAgentDto, ResetAgentPasswordDto, UpdateAgentDto } from './dto/agent.dto';
import { UpdateAgentWorkStatusDto } from './dto/update-agent-work-status.dto';
import { UsersService } from './users.service';

/**
 * Team management. The company admin (owner) manages agents (employees).
 * Agents can only read the team board.
 */
@Controller('users')
@ApiTags('Users / Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** Team board: any company member can see agents + their chat counts (no private data). */
  @Get('agents/stats')
  getAgentsWithStats(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getAgentsWithStats(user.company_id);
  }

  @Get('agents')
  @AdminOnly()
  getAgents(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getAgents(user.company_id);
  }

  @Post('agents')
  @AdminOnly()
  createAgent(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateAgentDto) {
    return this.usersService.createAgent(user.company_id, body);
  }

  @Patch('agents/:id')
  @AdminOnly()
  updateAgent(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: UpdateAgentDto) {
    return this.usersService.updateAgent(user, id, body);
  }

  @Patch('agents/:id/work-status')
  @AdminOnly()
  updateAgentWorkStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateAgentWorkStatusDto,
  ) {
    return this.usersService.updateAgentWorkStatus(user.company_id, id, body.status);
  }

  @Post('agents/:id/toggle')
  @HttpCode(200)
  @AdminOnly()
  toggleAgent(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.usersService.toggleAgent(user.company_id, id);
  }

  /** Set a new password for an agent (the agent is signed out everywhere). */
  @Post('agents/:id/reset-password')
  @HttpCode(200)
  @AdminOnly()
  resetAgentPassword(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() body: ResetAgentPasswordDto) {
    return this.usersService.resetAgentPassword(user, id, body.password);
  }

  /** Remove access: the agent cannot log in, open chats go back to the queue, the seat is freed. */
  @Post('agents/:id/disable')
  @HttpCode(200)
  @AdminOnly()
  disableAgent(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.usersService.setAgentAccess(user, id, false);
  }

  @Post('agents/:id/enable')
  @HttpCode(200)
  @AdminOnly()
  enableAgent(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) {
    return this.usersService.setAgentAccess(user, id, true);
  }
}
