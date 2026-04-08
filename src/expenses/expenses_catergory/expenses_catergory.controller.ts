import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { ExpensesCatergoryService } from './expenses_catergory.service';
import { CreateExpensesCatergoryDto } from './dto/create-expenses_catergory.dto';
import { UpdateExpensesCatergoryDto } from './dto/update-expenses_catergory.dto';

@Controller('expenses-catergory')
export class ExpensesCatergoryController {
  constructor(
    private readonly expensesCatergoryService: ExpensesCatergoryService,
  ) {}

  @Post()
  create(@Body() createExpensesCatergoryDto: CreateExpensesCatergoryDto) {
    return this.expensesCatergoryService.create(createExpensesCatergoryDto);
  }

  @Get()
  findAll() {
    return this.expensesCatergoryService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.expensesCatergoryService.findOne(+id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateExpensesCatergoryDto: UpdateExpensesCatergoryDto,
  ) {
    return this.expensesCatergoryService.update(
      +id,
      updateExpensesCatergoryDto,
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.expensesCatergoryService.remove(+id);
  }
}
