import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { Company } from '../../company/entities/company.entity';
import { CreateProductCatergoryDto } from './dto/create-product_catergory.dto';
import { UpdateProductCatergoryDto } from './dto/update-product_catergory.dto';
import { ProductCatergory } from './entities/product_catergory.entity';

@Injectable()
export class ProductCatergoryService {
  constructor(
    @InjectRepository(ProductCatergory)
    private readonly productCategoryRepository: Repository<ProductCatergory>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
  ) {}

  private async assertProductBusiness(companyId: number) {
    const company = await this.companyRepository.findOne({ where: { id: companyId } });
    if (!company) {
      throw new NotFoundException(
        'Company not found for the current login. Please log out and log in again.',
      );
    }
    if (company.business_category === 'service') {
      throw new ForbiddenException('Product categories are not available for service-based businesses');
    }
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
      );

    if (excludeId) {
      qb.andWhere('category.id != :excludeId', { excludeId });
    }

    const existing = await qb.getOne();
    if (existing) {
      throw new ConflictException('Product category with this name already exists');
    }
  }

  private async ensureCompanyExists(companyId: number) {
    const exists = await this.companyRepository.exist({ where: { id: companyId } });
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
    await this.assertProductBusiness(user.company_id);

    const name = createProductCatergoryDto.name.trim();
    if (createProductCatergoryDto.is_common) {
      // shared categories are visible to every workspace – only the platform team can create them
      throw new ForbiddenException('Shared categories are managed by Agent Metra.');
    }
    await this.ensureCompanyExists(user.company_id);
    await this.ensureUniqueName(user.company_id, name);

    const category = this.productCategoryRepository.create({
      name,
      is_active: createProductCatergoryDto.is_active ?? true,
      is_common: false,
      company_id: user.company_id,
    });

    const savedCategory = await this.productCategoryRepository.save(category);
    return this.findOne(savedCategory.id, user);
  }

  async findAll(user: AuthenticatedUser) {
    await this.assertProductBusiness(user.company_id);

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
    await this.assertProductBusiness(user.company_id);

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
    const category = await this.findOwnedCategory(id, user);
    const normalizedName = updateProductCatergoryDto.name?.trim();
    if (updateProductCatergoryDto.is_common) {
      throw new ForbiddenException('Shared categories are managed by Agent Metra.');
    }

    if (
      normalizedName !== undefined &&
      normalizedName.toLowerCase() !== category.name.toLowerCase()
    ) {
      await this.ensureUniqueName(user.company_id, normalizedName, id);
    }

    this.productCategoryRepository.merge(category, {
      ...(updateProductCatergoryDto.is_active !== undefined ? { is_active: updateProductCatergoryDto.is_active } : {}),
      ...(normalizedName !== undefined ? { name: normalizedName } : {}),
    });

    const savedCategory = await this.productCategoryRepository.save(category);
    return this.findOne(savedCategory.id, user);
  }

  /** Only the workspace's own categories can be changed (shared ones are read-only). */
  private async findOwnedCategory(id: number, user: AuthenticatedUser) {
    const category = await this.findOne(id, user);
    if (category.is_common || Number(category.company_id) !== Number(user.company_id)) {
      throw new ForbiddenException('Shared categories cannot be changed.');
    }
    return category;
  }

  async remove(id: number, user: AuthenticatedUser) {
    const category = await this.findOwnedCategory(id, user);
    await this.productCategoryRepository.remove(category);
    return { id };
  }
}
