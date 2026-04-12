import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
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

  private async findAccessibleCategory(id: number, companyId: number) {
    const category = await this.expensesCategoryRepository
      .createQueryBuilder('category')
      .where('category.id = :id', { id })
      .andWhere(
        new Brackets((subQuery) => {
          subQuery
            .where('category.company_id = :companyId', { companyId })
            .orWhere('category.is_common = true');
        }),
      )
      .getOne();

    if (!category) {
      throw new NotFoundException('Expense category not found');
    }

    return category;
  }

  private async findOwnedExpense(id: number, companyId: number) {
    const expense = await this.expenseRepository.findOne({
      where: { id, company_id: companyId },
      relations: ['expenseCategory'],
    });

    if (!expense) {
      throw new NotFoundException('Expense not found');
    }

    return expense;
  }

  async create(createExpenseDto: CreateExpenseDto, user: AuthenticatedUser) {
    const category = await this.findAccessibleCategory(
      createExpenseDto.expense_category_id,
      user.company_id,
    );

    const expense = this.expenseRepository.create({
      amount: createExpenseDto.amount,
      date: createExpenseDto.date,
      note: createExpenseDto.note ?? '',
      sourse: createExpenseDto.sourse ?? SourseType.manual,
      created_user_id: user.id,
      company_id: user.company_id,
      expenseCategory: category,
    });

    return this.expenseRepository.save(expense);
  }

  async createMany(
    createExpenseDtos: CreateExpenseDto[],
    user: AuthenticatedUser,
  ) {
    const categories = await Promise.all(
      createExpenseDtos.map((expense) =>
        this.findAccessibleCategory(expense.expense_category_id, user.company_id),
      ),
    );

    const expenses = createExpenseDtos.map((expense, index) =>
      this.expenseRepository.create({
        amount: expense.amount,
        date: expense.date,
        note: expense.note ?? '',
        sourse: expense.sourse ?? SourseType.manual,
        created_user_id: user.id,
        company_id: user.company_id,
        expenseCategory: categories[index],
      }),
    );

    return this.expenseRepository.save(expenses);
  }

  async findAll(user: AuthenticatedUser) {
    return this.expenseRepository.find({
      where: { company_id: user.company_id },
      relations: ['expenseCategory'],
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number, user: AuthenticatedUser) {
    return this.findOwnedExpense(id, user.company_id);
  }

  async update(
    id: number,
    updateExpenseDto: UpdateExpenseDto,
    user: AuthenticatedUser,
  ) {
    const expense = await this.findOwnedExpense(id, user.company_id);

    if (updateExpenseDto.expense_category_id !== undefined) {
      expense.expenseCategory = await this.findAccessibleCategory(
        updateExpenseDto.expense_category_id,
        user.company_id,
      );
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

    return this.expenseRepository.save(expense);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const expense = await this.findOwnedExpense(id, user.company_id);
    await this.expenseRepository.remove(expense);

    return { id };
  }
}
