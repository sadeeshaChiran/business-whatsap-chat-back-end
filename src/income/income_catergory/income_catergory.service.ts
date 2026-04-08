import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
      .where('category.company_id = :companyId', { companyId })
      .andWhere('LOWER(category.name) = LOWER(:name)', { name });

    if (excludeId) {
      qb.andWhere('category.id != :excludeId', { excludeId });
    }

    const existingCategory = await qb.getOne();
    if (existingCategory) {
      throw new ConflictException(
        'Income category with this name already exists for this company',
      );
    }
  }

  async create(createIncomeCatergoryDto: CreateIncomeCatergoryDto) {
    const normalizedName = createIncomeCatergoryDto.name.trim();

    await this.ensureUniqueName(
      createIncomeCatergoryDto.company_id,
      normalizedName,
    );

    const category = this.incomeCategoryRepository.create({
      ...createIncomeCatergoryDto,
      name: normalizedName,
      is_common: createIncomeCatergoryDto.is_common ?? false,
      is_active: createIncomeCatergoryDto.is_active ?? true,
    });

    return this.incomeCategoryRepository.save(category);
  }

  async findAll() {
    return this.incomeCategoryRepository.find({
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number) {
    const category = await this.incomeCategoryRepository.findOne({
      where: { id },
    });

    if (!category) {
      throw new NotFoundException('Income category not found');
    }

    return category;
  }

  async update(id: number, updateIncomeCatergoryDto: UpdateIncomeCatergoryDto) {
    const category = await this.findOne(id);

    const normalizedName = updateIncomeCatergoryDto.name?.trim();
    const companyId = updateIncomeCatergoryDto.company_id ?? category.company_id;
    const categoryName = normalizedName ?? category.name;

    await this.ensureUniqueName(companyId, categoryName, id);

    this.incomeCategoryRepository.merge(category, {
      ...updateIncomeCatergoryDto,
      ...(normalizedName !== undefined ? { name: normalizedName } : {}),
    });
    return this.incomeCategoryRepository.save(category);
  }

  async remove(id: number) {
    const category = await this.findOne(id);
    await this.incomeCategoryRepository.remove(category);

    return { id };
  }
}
