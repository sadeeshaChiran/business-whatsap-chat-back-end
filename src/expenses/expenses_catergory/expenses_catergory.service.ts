import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

  private async ensureUniqueName(
    companyId: number,
    name: string,
    excludeId?: number,
  ): Promise<void> {
    const qb = this.expensesCategoryRepository
      .createQueryBuilder('category')
      .where('category.company_id = :companyId', { companyId })
      .andWhere('LOWER(category.name) = LOWER(:name)', { name });

    if (excludeId) {
      qb.andWhere('category.id != :excludeId', { excludeId });
    }

    const existingCategory = await qb.getOne();
    if (existingCategory) {
      throw new ConflictException(
        'Expense category with this name already exists for this company',
      );
    }
  }

  async create(createExpensesCatergoryDto: CreateExpensesCatergoryDto) {
    const normalizedName = createExpensesCatergoryDto.name.trim();

    await this.ensureUniqueName(
      createExpensesCatergoryDto.company_id,
      normalizedName,
    );

    const category = this.expensesCategoryRepository.create({
      ...createExpensesCatergoryDto,
      name: normalizedName,
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

    const normalizedName = updateExpensesCatergoryDto.name?.trim();
    const companyId =
      updateExpensesCatergoryDto.company_id ?? category.company_id;
    const categoryName = normalizedName ?? category.name;

    await this.ensureUniqueName(companyId, categoryName, id);

    this.expensesCategoryRepository.merge(category, {
      ...updateExpensesCatergoryDto,
      ...(normalizedName !== undefined ? { name: normalizedName } : {}),
    });
    return this.expensesCategoryRepository.save(category);
  }

  async remove(id: number) {
    const category = await this.findOne(id);
    await this.expensesCategoryRepository.remove(category);

    return { id };
  }
}
