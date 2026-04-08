import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateExpensesCatergoryDto } from './dto/create-expenses_catergory.dto';
import { UpdateExpensesCatergoryDto } from './dto/update-expenses_catergory.dto';
import { ExpensesCatergory } from './entities/expenses_catergory.entity';

@Injectable()
export class ExpensesCatergoryService {
  constructor(
    @InjectRepository(ExpensesCatergory)
    private readonly expensesCategoryRepository: Repository<ExpensesCatergory>,
  ) {}

  async create(createExpensesCatergoryDto: CreateExpensesCatergoryDto) {
    const category = this.expensesCategoryRepository.create({
      ...createExpensesCatergoryDto,
      is_common: createExpensesCatergoryDto.is_common ?? false,
      is_active: createExpensesCatergoryDto.is_active ?? true,
    });

    return this.expensesCategoryRepository.save(category);
  }

  async findAll() {
    return this.expensesCategoryRepository.find({
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number) {
    const category = await this.expensesCategoryRepository.findOne({
      where: { id },
    });

    if (!category) {
      throw new NotFoundException('Expense category not found');
    }

    return category;
  }

  async update(
    id: number,
    updateExpensesCatergoryDto: UpdateExpensesCatergoryDto,
  ) {
    const category = await this.findOne(id);

    this.expensesCategoryRepository.merge(category, updateExpensesCatergoryDto);
    return this.expensesCategoryRepository.save(category);
  }

  async remove(id: number) {
    const category = await this.findOne(id);
    await this.expensesCategoryRepository.remove(category);

    return { id };
  }
}
