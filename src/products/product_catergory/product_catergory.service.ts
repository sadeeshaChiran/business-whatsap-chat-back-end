import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ProductCategoryVariant } from './entities/product_category_variant.entity';
import { CreateProductCatergoryDto } from './dto/create-product_catergory.dto';
import { UpdateProductCatergoryDto } from './dto/update-product_catergory.dto';
import { ProductCatergory } from './entities/product_catergory.entity';

@Injectable()
export class ProductCatergoryService {
  constructor(
    @InjectRepository(ProductCatergory)
    private readonly productCategoryRepository: Repository<ProductCatergory>,
    @InjectRepository(ProductCategoryVariant)
    private readonly productCategoryVariantRepository: Repository<ProductCategoryVariant>,
  ) {}

  private normalizeDefaultVariants(
    defaultVariants?: Array<{ variant_name: string }>,
  ) {
    const seen = new Set<string>();

    return (defaultVariants ?? [])
      .map((variant) => ({
        variant_name: variant.variant_name.trim(),
      }))
      .filter((variant) => {
        if (!variant.variant_name) {
          return false;
        }

        const key = variant.variant_name.toLowerCase();
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });
  }

  private async setDefaultVariants(
    category: ProductCatergory,
    defaultVariants?: Array<{ variant_name: string }>,
  ) {
    const normalizedVariants = this.normalizeDefaultVariants(defaultVariants);

    await this.productCategoryVariantRepository.delete({
      category_id: category.id,
    });

    if (!normalizedVariants.length) {
      return [];
    }

    return this.productCategoryVariantRepository.save(
      normalizedVariants.map((variant) =>
        this.productCategoryVariantRepository.create({
          category_id: category.id,
          variant_name: variant.variant_name,
        }),
      ),
    );
  }

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

  async create(
    createProductCatergoryDto: CreateProductCatergoryDto,
    user: AuthenticatedUser,
  ) {
    const name = createProductCatergoryDto.name.trim();
    await this.ensureUniqueName(user.company_id, name);

    const category = this.productCategoryRepository.create({
      name,
      is_active: createProductCatergoryDto.is_active ?? true,
      is_common: createProductCatergoryDto.is_common ?? false,
      company_id: createProductCatergoryDto.is_common ? null : user.company_id,
    });

    const savedCategory = await this.productCategoryRepository.save(category);
    await this.setDefaultVariants(
      savedCategory,
      createProductCatergoryDto.default_variants,
    );

    return this.findOne(savedCategory.id, user);
  }

  async findAll(user: AuthenticatedUser) {
    return this.productCategoryRepository
      .createQueryBuilder('category')
      .leftJoinAndSelect('category.default_variants', 'default_variants')
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
      .leftJoinAndSelect('category.default_variants', 'default_variants')
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

    if (updateProductCatergoryDto.default_variants !== undefined) {
      await this.setDefaultVariants(
        savedCategory,
        updateProductCatergoryDto.default_variants,
      );
    }

    return this.findOne(savedCategory.id, user);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const category = await this.findOne(id, user);
    await this.productCategoryRepository.remove(category);

    return { id };
  }
}
