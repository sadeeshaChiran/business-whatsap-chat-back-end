import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { UsersService } from './users.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Company } from '../company/entities/company.entity';
import { Repository } from 'typeorm';

@Controller('users')
@ApiTags('Users / Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
  ) {}

  private async assertAdmin(user: AuthenticatedUser) {
    const company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });
    if (!company || Number(company.admin_user_id) !== Number(user.id)) {
      throw new ForbiddenException('Only the company admin can manage agents.');
    }
  }

  /** Read-only: any company member can see agents + their conversation stats */
  @Get('agents/stats')
  async getAgentsWithStats(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getAgentsWithStats(user.company_id);
  }

  @Get('agents')
  async getAgents(@CurrentUser() user: AuthenticatedUser) {
    await this.assertAdmin(user);
    return this.usersService.getAgents(user.company_id);
  }

  @Post('agents')
  async createAgent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { name: string; email: string; password?: string },
  ) {
    await this.assertAdmin(user);
    // Provide a default password if not provided
    const password = body.password || 'AgentPassword123!';
    return this.usersService.createAgent(
      user.company_id,
      body.name,
      body.email,
      password,
    );
  }

  @Post('agents/:id/toggle')
  async toggleAgent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.assertAdmin(user);
    return this.usersService.toggleAgent(user.company_id, Number(id));
  }
}
