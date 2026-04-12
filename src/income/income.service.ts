import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SourseType } from '../expenses/entities/expense.entity';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';
import { Income } from './entities/income.entity';
import { IncomeCatergory } from './income_catergory/entities/income_catergory.entity';

@Injectable()
export class IncomeService {
  constructor(
    @InjectRepository(Income)
    private readonly incomeRepository: Repository<Income>,
    @InjectRepository(IncomeCatergory)
    private readonly incomeCategoryRepository: Repository<IncomeCatergory>,
  ) {}

  private async findAccessibleCategory(id: number, companyId: number) {
    const category = await this.incomeCategoryRepository
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
      throw new NotFoundException('Income category not found');
    }

    return category;
  }

  private async findOwnedIncome(id: number, companyId: number) {
    const income = await this.incomeRepository.findOne({
      where: { id, company_id: companyId },
      relations: ['incomeCategory'],
    });

    if (!income) {
      throw new NotFoundException('Income not found');
    }

    return income;
  }

  async create(createIncomeDto: CreateIncomeDto, user: AuthenticatedUser) {
    const category = await this.findAccessibleCategory(
      createIncomeDto.income_category_id,
      user.company_id,
    );

    const income = this.incomeRepository.create({
      amount: createIncomeDto.amount,
      date: createIncomeDto.date,
      note: createIncomeDto.note ?? '',
      sourse: createIncomeDto.sourse ?? SourseType.manual,
      created_user_id: user.id,
      company_id: user.company_id,
      incomeCategory: category,
    });

    return this.incomeRepository.save(income);
  }

  async createMany(createIncomeDtos: CreateIncomeDto[], user: AuthenticatedUser) {
    const categories = await Promise.all(
      createIncomeDtos.map((income) =>
        this.findAccessibleCategory(income.income_category_id, user.company_id),
      ),
    );

    const incomes = createIncomeDtos.map((income, index) =>
      this.incomeRepository.create({
        amount: income.amount,
        date: income.date,
        note: income.note ?? '',
        sourse: income.sourse ?? SourseType.manual,
        created_user_id: user.id,
        company_id: user.company_id,
        incomeCategory: categories[index],
      }),
    );

    return this.incomeRepository.save(incomes);
  }

  async findAll(user: AuthenticatedUser) {
    return this.incomeRepository.find({
      where: { company_id: user.company_id },
      relations: ['incomeCategory'],
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number, user: AuthenticatedUser) {
    return this.findOwnedIncome(id, user.company_id);
  }

  async update(
    id: number,
    updateIncomeDto: UpdateIncomeDto,
    user: AuthenticatedUser,
  ) {
    const income = await this.findOwnedIncome(id, user.company_id);

    if (updateIncomeDto.income_category_id !== undefined) {
      income.incomeCategory = await this.findAccessibleCategory(
        updateIncomeDto.income_category_id,
        user.company_id,
      );
    }

    if (updateIncomeDto.amount !== undefined) {
      income.amount = updateIncomeDto.amount;
    }
    if (updateIncomeDto.date !== undefined) {
      income.date = updateIncomeDto.date;
    }
    if (updateIncomeDto.note !== undefined) {
      income.note = updateIncomeDto.note ?? '';
    }
    if (updateIncomeDto.sourse !== undefined) {
      income.sourse = updateIncomeDto.sourse;
    }

    return this.incomeRepository.save(income);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const income = await this.findOwnedIncome(id, user.company_id);
    await this.incomeRepository.remove(income);

    return { id };
  }
}
