import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { SupabaseCompanyService } from '../../supabase/supabase-company.service';
import { Company } from '../../company/entities/company.entity';
import { SUPABASE_DATA_SOURCE } from '../../common/supabase-database';
import { CreateProductCatergoryDto } from './dto/create-product_catergory.dto';
import { UpdateProductCatergoryDto } from './dto/update-product_catergory.dto';
import { PRODUCT_DATA_SOURCE } from '../product-database';
import { ProductCatergory } from './entities/product_catergory.entity';

@Injectable()
export class ProductCatergoryService {
  constructor(
    @InjectRepository(ProductCatergory, PRODUCT_DATA_SOURCE)
    private readonly productCategoryRepository: Repository<ProductCatergory>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @Optional()
    private readonly supabaseCompanyService?: SupabaseCompanyService,
  ) {}

  private async ensureUniqueName(
    companyId: number,
    name: string,
    excludeId?: number,
  ) {
    const qb = this.productCategoryRepository
      .createQueryBuilder('category')
      .where('LOWER(category.name) = LOWER(:name)', { name })
      .andWhere(
        new Brackets((subQuery) => {
          subQuery
            .where('category.company_id = :companyId', { companyId })
            .orWhere('category.is_common = true');
        }),
      )

    if (excludeId) {
      qb.andWhere('category.id != :excludeId', { excludeId });
    }

    const existing = await qb.getOne();
    if (existing) {
      throw new ConflictException('Product category with this name already exists');
    }
  }

  private async ensureCompanyExists(companyId: number) {
    const exists =
      SUPABASE_DATA_SOURCE && this.supabaseCompanyService
        ? await this.supabaseCompanyService.exists(companyId)
        : await this.companyRepository.exist({ where: { id: companyId } });

    if (!exists) {
      throw new NotFoundException(
        'Company not found for the current login. Please log out and log in again.',
      );
    }
  }

  async create(
    createProductCatergoryDto: CreateProductCatergoryDto,
    user: AuthenticatedUser,
  ) {
    const name = createProductCatergoryDto.name.trim();
    if (!createProductCatergoryDto.is_common) {
      await this.ensureCompanyExists(user.company_id);
    }
    await this.ensureUniqueName(user.company_id, name);

    const category = this.productCategoryRepository.create({
      name,
      is_active: createProductCatergoryDto.is_active ?? true,
      is_common: createProductCatergoryDto.is_common ?? false,
      company_id: createProductCatergoryDto.is_common ? null : user.company_id,
    });

    const savedCategory = await this.productCategoryRepository.save(category);

    return this.findOne(savedCategory.id, user);
  }

  async findAll(user: AuthenticatedUser) {
    return this.productCategoryRepository
      .createQueryBuilder('category')
      .where(
        new Brackets((subQuery) => {
          subQuery
            .where('category.company_id = :companyId', { companyId: user.company_id })
            .orWhere('category.is_common = true');
        }),
      )
      .orderBy('category.is_common', 'DESC')
      .addOrderBy('category.id', 'DESC')
      .getMany();
  }

  async findOne(id: number, user: AuthenticatedUser) {
    const category = await this.productCategoryRepository
      .createQueryBuilder('category')
      .where('category.id = :id', { id })
      .andWhere(
        new Brackets((subQuery) => {
          subQuery
            .where('category.company_id = :companyId', { companyId: user.company_id })
            .orWhere('category.is_common = true');
        }),
      )
      .getOne();

    if (!category) {
      throw new NotFoundException('Product category not found');
    }

    return category;
  }

  async update(
    id: number,
    updateProductCatergoryDto: UpdateProductCatergoryDto,
    user: AuthenticatedUser,
  ) {
    const category = await this.findOne(id, user);
    const normalizedName = updateProductCatergoryDto.name?.trim();

    if (
      normalizedName !== undefined &&
      normalizedName.toLowerCase() !== category.name.toLowerCase()
    ) {
      await this.ensureUniqueName(user.company_id, normalizedName, id);
    }

    this.productCategoryRepository.merge(category, {
      ...updateProductCatergoryDto,
      ...(updateProductCatergoryDto.is_common !== undefined
        ? {
            company_id: updateProductCatergoryDto.is_common
              ? null
              : (category.company_id ?? user.company_id),
          }
        : {}),
      ...(normalizedName !== undefined ? { name: normalizedName } : {}),
    });

    const savedCategory = await this.productCategoryRepository.save(category);

    return this.findOne(savedCategory.id, user);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const category = await this.findOne(id, user);
    await this.productCategoryRepository.remove(category);

    return { id };
  }
}
