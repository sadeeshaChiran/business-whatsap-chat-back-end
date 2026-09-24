import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AutomationService } from './automation.service';
import { SaveAutomationFlowDto } from './dto/save-automation-flow.dto';

@Controller('automation/flows')
@UseGuards(JwtAuthGuard)
export class AutomationController {
  constructor(private readonly service: AutomationService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.service.list(user); }
  @Get(':id') get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.service.get(user, id); }
  @Post() create(@CurrentUser() user: AuthenticatedUser, @Body() dto: SaveAutomationFlowDto) { return this.service.create(user, dto); }
  @Patch(':id') update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SaveAutomationFlowDto) { return this.service.update(user, id, dto); }
  @Delete(':id') remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.service.remove(user, id); }
}
