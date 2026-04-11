import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { IncomeService } from './income.service';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';

@Controller('income')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class IncomeController {
  constructor(private readonly incomeService: IncomeService) {}

  @Post()
  create(
    @Body() createIncomeDto: CreateIncomeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.incomeService.create(createIncomeDto, user);
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.incomeService.findAll(user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.incomeService.findOne(+id, user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateIncomeDto: UpdateIncomeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.incomeService.update(+id, updateIncomeDto, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.incomeService.remove(+id, user);
  }
}
