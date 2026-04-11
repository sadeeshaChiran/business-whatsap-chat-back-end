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
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ExpensesCatergoryService } from './expenses_catergory.service';
import { CreateExpensesCatergoryDto } from './dto/create-expenses_catergory.dto';
import { UpdateExpensesCatergoryDto } from './dto/update-expenses_catergory.dto';

@Controller('expenses-catergory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class ExpensesCatergoryController {
  constructor(
    private readonly expensesCatergoryService: ExpensesCatergoryService,
  ) {}

  @Post()
  create(
    @Body() createExpensesCatergoryDto: CreateExpensesCatergoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.expensesCatergoryService.create(createExpensesCatergoryDto, user);
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.expensesCatergoryService.findAll(user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.expensesCatergoryService.findOne(+id, user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateExpensesCatergoryDto: UpdateExpensesCatergoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.expensesCatergoryService.update(
      +id,
      updateExpensesCatergoryDto,
      user,
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.expensesCatergoryService.remove(+id, user);
  }
}
