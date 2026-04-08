import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';
import { Income } from './entities/income.entity';
import { SourseType } from '../expenses/entities/expense.entity';
import { IncomeCatergory } from './income_catergory/entities/income_catergory.entity';

@Injectable()
export class IncomeService {
  constructor(
    @InjectRepository(Income)
    private readonly incomeRepository: Repository<Income>,
    @InjectRepository(IncomeCatergory)
    private readonly incomeCategoryRepository: Repository<IncomeCatergory>,
  ) {}

  async create(createIncomeDto: CreateIncomeDto) {
    const category = await this.incomeCategoryRepository.findOne({
      where: { id: createIncomeDto.income_category_id },
    });

    if (!category) {
      throw new NotFoundException('Income category not found');
    }

    const income = this.incomeRepository.create({
      amount: createIncomeDto.amount,
      date: createIncomeDto.date,
      note: createIncomeDto.note ?? '',
      sourse: createIncomeDto.sourse ?? SourseType.manual,
      created_user_id: createIncomeDto.created_user_id ?? 0,
      company_id: createIncomeDto.company_id,
      incomeCategory: category,
    });

    return this.incomeRepository.save(income);
  }

  async findAll() {
    return this.incomeRepository.find({
      relations: ['incomeCategory'],
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number) {
    const income = await this.incomeRepository.findOne({
      where: { id },
      relations: ['incomeCategory'],
    });

    if (!income) {
      throw new NotFoundException('Income not found');
    }

    return income;
  }

  async update(id: number, updateIncomeDto: UpdateIncomeDto) {
    const income = await this.findOne(id);

    if (updateIncomeDto.income_category_id !== undefined) {
      const category = await this.incomeCategoryRepository.findOne({
        where: { id: updateIncomeDto.income_category_id },
      });

      if (!category) {
        throw new NotFoundException('Income category not found');
      }

      income.incomeCategory = category;
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
    if (updateIncomeDto.created_user_id !== undefined) {
      income.created_user_id = updateIncomeDto.created_user_id ?? 0;
    }
    if (updateIncomeDto.company_id !== undefined) {
      income.company_id = updateIncomeDto.company_id;
    }

    return this.incomeRepository.save(income);
  }

  async remove(id: number) {
    const income = await this.findOne(id);
    await this.incomeRepository.remove(income);

    return { id };
  }
}
