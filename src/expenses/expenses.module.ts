import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExpensesService } from './expenses.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesCatergoryModule } from './expenses_catergory/expenses_catergory.module';
import { Expense } from './entities/expense.entity';
import { ExpensesCatergory } from './expenses_catergory/entities/expenses_catergory.entity';

@Module({
  controllers: [ExpensesController],
  providers: [ExpensesService],
  imports: [
    TypeOrmModule.forFeature([Expense, ExpensesCatergory]),
    ExpensesCatergoryModule,
  ],
})
export class ExpensesModule {}
