import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
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
      .where('LOWER(category.name) = LOWER(:name)', { name })
      .andWhere(
        new Brackets((subQuery) => {
          subQuery
            .where('category.company_id = :companyId', { companyId })
            .orWhere('category.is_common = true');
        }),
      );

    if (excludeId) {
      qb.andWhere('category.id != :excludeId', { excludeId });
    }

    const existingCategory = await qb.getOne();
    if (existingCategory) {
      throw new ConflictException(
        'Expense category with this name already exists or is already shared',
      );
    }
  }

  private accessibleQuery(companyId: number) {
    return this.expensesCategoryRepository
      .createQueryBuilder('category')
      .where(
        new Brackets((subQuery) => {
          subQuery
            .where('category.company_id = :companyId', { companyId })
            .orWhere('category.is_common = true');
        }),
      );
  }

  async create(
    createExpensesCatergoryDto: CreateExpensesCatergoryDto,
    user: AuthenticatedUser,
  ) {
    const normalizedName = createExpensesCatergoryDto.name.trim();

    await this.ensureUniqueName(user.company_id, normalizedName);

    const category = this.expensesCategoryRepository.create({
      ...createExpensesCatergoryDto,
      company_id: createExpensesCatergoryDto.is_common ? null : user.company_id,
      name: normalizedName,
      is_common: createExpensesCatergoryDto.is_common ?? false,
      is_active: createExpensesCatergoryDto.is_active ?? true,
    });

    return this.expensesCategoryRepository.save(category);
  }

  async findAll(user: AuthenticatedUser) {
    return this.accessibleQuery(user.company_id)
      .orderBy('category.is_common', 'DESC')
      .addOrderBy('category.id', 'DESC')
      .getMany();
  }

  async findOne(id: number, user: AuthenticatedUser) {
    const category = await this.accessibleQuery(user.company_id)
      .andWhere('category.id = :id', { id })
      .getOne();

    if (!category) {
      throw new NotFoundException('Expense category not found');
    }

    return category;
  }

  private async findOwnedOne(id: number, companyId: number) {
    const category = await this.expensesCategoryRepository.findOne({
      where: [{ id, company_id: companyId }, { id, is_common: true }],
    });

    if (!category) {
      throw new NotFoundException('Expense category not found');
    }

    return category;
  }

  async update(
    id: number,
    updateExpensesCatergoryDto: UpdateExpensesCatergoryDto,
    user: AuthenticatedUser,
  ) {
    const category = await this.findOwnedOne(id, user.company_id);

    const normalizedName = updateExpensesCatergoryDto.name?.trim();
    const categoryName = normalizedName ?? category.name;

    const shouldValidateName =
      (normalizedName !== undefined &&
        normalizedName.toLowerCase() !== category.name.toLowerCase()) ||
      (updateExpensesCatergoryDto.is_common !== undefined &&
        updateExpensesCatergoryDto.is_common !== category.is_common);

    if (shouldValidateName) {
      await this.ensureUniqueName(user.company_id, categoryName, id);
    }

    this.expensesCategoryRepository.merge(category, {
      ...updateExpensesCatergoryDto,
      company_id: updateExpensesCatergoryDto.is_common ? null : (category.company_id ?? user.company_id),
      ...(normalizedName !== undefined ? { name: normalizedName } : {}),
    });
    return this.expensesCategoryRepository.save(category);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const category = await this.findOwnedOne(id, user.company_id);
    await this.expensesCategoryRepository.remove(category);

    return { id };
  }
}
