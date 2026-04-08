import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { Expense, SourseType } from './entities/expense.entity';
import { ExpensesCatergory } from './expenses_catergory/entities/expenses_catergory.entity';

@Injectable()
export class ExpensesService {
  constructor(
    @InjectRepository(Expense)
    private readonly expenseRepository: Repository<Expense>,
    @InjectRepository(ExpensesCatergory)
    private readonly expensesCategoryRepository: Repository<ExpensesCatergory>,
  ) {}

  async create(createExpenseDto: CreateExpenseDto) {
    const category = await this.expensesCategoryRepository.findOne({
      where: { id: createExpenseDto.expense_category_id },
    });

    if (!category) {
      throw new NotFoundException('Expense category not found');
    }

    const expense = this.expenseRepository.create({
      amount: createExpenseDto.amount,
      date: createExpenseDto.date,
      note: createExpenseDto.note ?? '',
      sourse: createExpenseDto.sourse ?? SourseType.manual,
      created_user_id: createExpenseDto.created_user_id ?? 0,
      company_id: createExpenseDto.company_id,
      expenseCategory: category,
    });

    return this.expenseRepository.save(expense);
  }

  async findAll() {
    return this.expenseRepository.find({
      relations: ['expenseCategory'],
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number) {
    const expense = await this.expenseRepository.findOne({
      where: { id },
      relations: ['expenseCategory'],
    });

    if (!expense) {
      throw new NotFoundException('Expense not found');
    }

    return expense;
  }

  async update(id: number, updateExpenseDto: UpdateExpenseDto) {
    const expense = await this.findOne(id);

    if (updateExpenseDto.expense_category_id !== undefined) {
      const category = await this.expensesCategoryRepository.findOne({
        where: { id: updateExpenseDto.expense_category_id },
      });

      if (!category) {
        throw new NotFoundException('Expense category not found');
      }

      expense.expenseCategory = category;
    }

    if (updateExpenseDto.amount !== undefined) {
      expense.amount = updateExpenseDto.amount;
    }
    if (updateExpenseDto.date !== undefined) {
      expense.date = updateExpenseDto.date;
    }
    if (updateExpenseDto.note !== undefined) {
      expense.note = updateExpenseDto.note ?? '';
    }
    if (updateExpenseDto.sourse !== undefined) {
      expense.sourse = updateExpenseDto.sourse;
    }
    if (updateExpenseDto.created_user_id !== undefined) {
      expense.created_user_id = updateExpenseDto.created_user_id ?? 0;
    }
    if (updateExpenseDto.company_id !== undefined) {
      expense.company_id = updateExpenseDto.company_id;
    }

    return this.expenseRepository.save(expense);
  }

  async remove(id: number) {
    const expense = await this.findOne(id);
    await this.expenseRepository.remove(expense);

    return { id };
  }
}
