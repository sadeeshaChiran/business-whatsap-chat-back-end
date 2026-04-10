import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CreateIncomeCatergoryDto } from './dto/create-income_catergory.dto';
import { UpdateIncomeCatergoryDto } from './dto/update-income_catergory.dto';
import { IncomeCatergory } from './entities/income_catergory.entity';

@Injectable()
export class IncomeCatergoryService {
  constructor(
    @InjectRepository(IncomeCatergory)
    private readonly incomeCategoryRepository: Repository<IncomeCatergory>,
  ) {}

  private async ensureUniqueName(
    companyId: number,
    name: string,
    excludeId?: number,
  ): Promise<void> {
    const qb = this.incomeCategoryRepository
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
        'Income category with this name already exists or is already shared',
      );
    }
  }

  private accessibleQuery(companyId: number) {
    return this.incomeCategoryRepository
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
    createIncomeCatergoryDto: CreateIncomeCatergoryDto,
    user: AuthenticatedUser,
  ) {
    const normalizedName = createIncomeCatergoryDto.name.trim();

    await this.ensureUniqueName(user.company_id, normalizedName);

    const category = this.incomeCategoryRepository.create({
      ...createIncomeCatergoryDto,
      company_id: user.company_id,
      name: normalizedName,
      is_common: createIncomeCatergoryDto.is_common ?? false,
      is_active: createIncomeCatergoryDto.is_active ?? true,
    });

    return this.incomeCategoryRepository.save(category);
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
      throw new NotFoundException('Income category not found');
    }

    return category;
  }

  private async findOwnedOne(id: number, companyId: number) {
    const category = await this.incomeCategoryRepository.findOne({
      where: { id, company_id: companyId },
    });

    if (!category) {
      throw new NotFoundException('Income category not found');
    }

    return category;
  }

  async update(
    id: number,
    updateIncomeCatergoryDto: UpdateIncomeCatergoryDto,
    user: AuthenticatedUser,
  ) {
    const category = await this.findOwnedOne(id, user.company_id);

    const normalizedName = updateIncomeCatergoryDto.name?.trim();
    const categoryName = normalizedName ?? category.name;

    const shouldValidateName =
      (normalizedName !== undefined &&
        normalizedName.toLowerCase() !== category.name.toLowerCase()) ||
      (updateIncomeCatergoryDto.is_common !== undefined &&
        updateIncomeCatergoryDto.is_common !== category.is_common);

    if (shouldValidateName) {
      await this.ensureUniqueName(user.company_id, categoryName, id);
    }

    this.incomeCategoryRepository.merge(category, {
      ...updateIncomeCatergoryDto,
      company_id: user.company_id,
      ...(normalizedName !== undefined ? { name: normalizedName } : {}),
    });
    return this.incomeCategoryRepository.save(category);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const category = await this.findOwnedOne(id, user.company_id);
    await this.incomeCategoryRepository.remove(category);

    return { id };
  }
}
