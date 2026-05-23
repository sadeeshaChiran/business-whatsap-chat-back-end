import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as XLSX from 'xlsx';
import { Brackets, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductVariant } from './entities/product-variant.entity';
import { Product } from './entities/product.entity';
import { ProductCatergory } from './product_catergory/entities/product_catergory.entity';
import { PRODUCT_DATA_SOURCE } from './product-database';

type ImportVariant = {
  variant_name: string;
  variant_value: string;
};

type ImportRow = {
  rowNumber: number;
  name: string;
  description: string;
  sku: string;
  price: number;
  secondaryPrice1: number;
  secondaryPrice2: number;
  quantity: number;
  status: string;
  categoryName: string;
  hasVariants: boolean;
  variants: ImportVariant[];
};

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product, PRODUCT_DATA_SOURCE)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(ProductVariant, PRODUCT_DATA_SOURCE)
    private readonly productVariantRepository: Repository<ProductVariant>,
    @InjectRepository(ProductCatergory, PRODUCT_DATA_SOURCE)
    private readonly productCategoryRepository: Repository<ProductCatergory>,
  ) {}

  private normalizeVariants(variants?: ImportVariant[]) {
    return (variants ?? [])
      .map((variant) => ({
        variant_name: variant.variant_name.trim(),
        variant_value: variant.variant_value.trim(),
      }))
      .filter((variant) => variant.variant_name && variant.variant_value);
  }

  private async findOwnedProduct(id: number, companyId: number) {
    const product = await this.productRepository.findOne({
      where: { id, company_id: companyId, is_deleted: false },
      relations: ['category', 'variants'],
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  private async findCategoryForCompany(id: number, companyId: number) {
    const category = await this.productCategoryRepository
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
      throw new NotFoundException('Product category not found');
    }

    return category;
  }

  private async ensureCategoryByName(name: string, companyId: number) {
    const normalizedName = name.trim();

    if (!normalizedName) {
      throw new BadRequestException('Category is required for product import');
    }

    let category = await this.productCategoryRepository
      .createQueryBuilder('category')
      .where('category.company_id = :companyId', { companyId })
      .andWhere('LOWER(category.name) = LOWER(:name)', { name: normalizedName })
      .getOne();

    if (!category) {
      category = await this.productCategoryRepository.save(
        this.productCategoryRepository.create({
          name: normalizedName,
          company_id: companyId,
          is_active: true,
        }),
      );
    }

    return category;
  }

  private buildVariantEntities(product: Product, variants: ImportVariant[]) {
    return this.normalizeVariants(variants).map((variant) =>
      this.productVariantRepository.create({
        ...variant,
        product,
      }),
    );
  }

  async create(createProductDto: CreateProductDto, user: AuthenticatedUser) {
    const category = await this.findCategoryForCompany(
      createProductDto.category_id,
      user.company_id,
    );

    const normalizedVariants = this.normalizeVariants(createProductDto.variants);

    const product = this.productRepository.create({
      name: createProductDto.name.trim(),
      description: createProductDto.description?.trim() ?? '',
      sku: createProductDto.sku?.trim() ?? '',
      price: Number(createProductDto.price),
      secondary_price_1: Number(createProductDto.secondary_price_1 ?? 0),
      secondary_price_2: Number(createProductDto.secondary_price_2 ?? 0),
      quantity: Number(createProductDto.quantity ?? 0),
      ...(createProductDto.status !== undefined
        ? { status: createProductDto.status.trim() || 'In Stock' }
        : {}),
      category_id: category.id,
      company_id: user.company_id,
      created_by: user.id,
      has_variants: createProductDto.has_variants ?? normalizedVariants.length > 0,
      is_deleted: false,
      category,
    });

    const savedProduct = await this.productRepository.save(product);

    if (savedProduct.has_variants && normalizedVariants.length) {
      savedProduct.variants = await this.productVariantRepository.save(
        this.buildVariantEntities(savedProduct, normalizedVariants),
      );
    } else {
      savedProduct.variants = [];
    }

    return this.findOwnedProduct(savedProduct.id, user.company_id);
  }

  async findAll(user: AuthenticatedUser, categoryId?: number) {
    const where = {
      company_id: user.company_id,
      is_deleted: false,
      ...(categoryId ? { category_id: categoryId } : {}),
    };

    return this.productRepository.find({
      where,
      relations: ['category', 'variants'],
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number, user: AuthenticatedUser) {
    return this.findOwnedProduct(id, user.company_id);
  }

  async update(
    id: number,
    updateProductDto: UpdateProductDto,
    user: AuthenticatedUser,
  ) {
    const product = await this.findOwnedProduct(id, user.company_id);

    if (updateProductDto.category_id !== undefined) {
      product.category = await this.findCategoryForCompany(
        updateProductDto.category_id,
        user.company_id,
      );
      product.category_id = product.category.id;
    }

    if (updateProductDto.name !== undefined) {
      product.name = updateProductDto.name.trim();
    }
    if (updateProductDto.description !== undefined) {
      product.description = updateProductDto.description?.trim() ?? '';
    }
    if (updateProductDto.sku !== undefined) {
      product.sku = updateProductDto.sku?.trim() ?? '';
    }
    if (updateProductDto.price !== undefined) {
      product.price = Number(updateProductDto.price);
    }
    if (updateProductDto.secondary_price_1 !== undefined) {
      product.secondary_price_1 = Number(updateProductDto.secondary_price_1 ?? 0);
    }
    if (updateProductDto.secondary_price_2 !== undefined) {
      product.secondary_price_2 = Number(updateProductDto.secondary_price_2 ?? 0);
    }
    if (updateProductDto.quantity !== undefined) {
      product.quantity = Number(updateProductDto.quantity ?? 0);
    }
    if (updateProductDto.status !== undefined) {
      product.status = updateProductDto.status?.trim() || 'In Stock';
    }

    const normalizedVariants = this.normalizeVariants(updateProductDto.variants);
    const hasVariants =
      updateProductDto.has_variants ?? (updateProductDto.variants !== undefined
        ? normalizedVariants.length > 0
        : product.has_variants);

    product.has_variants = hasVariants;

    const savedProduct = await this.productRepository.save(product);

    if (updateProductDto.variants !== undefined || updateProductDto.has_variants !== undefined) {
      await this.productVariantRepository.delete({ product_id: savedProduct.id });

      if (hasVariants && normalizedVariants.length) {
        await this.productVariantRepository.save(
          this.buildVariantEntities(savedProduct, normalizedVariants),
        );
      }
    }

    return this.findOwnedProduct(savedProduct.id, user.company_id);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const product = await this.findOwnedProduct(id, user.company_id);
    await this.productVariantRepository.delete({ product_id: product.id });
    await this.productRepository.remove(product);

    return { id };
  }

  private readImportRows(file: { buffer: Buffer }) {
    const workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      throw new BadRequestException('The uploaded file does not contain any sheets');
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
      defval: '',
      raw: false,
    });

    if (!rows.length) {
      throw new BadRequestException('The uploaded file does not contain any product rows');
    }

    return rows;
  }

  private normalizeBoolean(value: unknown) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return ['true', 'yes', '1', 'y'].includes(normalized);
  }

  private normalizePrice(value: unknown) {
    const cleaned = String(value ?? '')
      .trim()
      .replace(/,/g, '')
      .replace(/[^0-9.-]/g, '');

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  private getRowValue(row: Record<string, unknown>, patterns: RegExp[]) {
    const entry = Object.entries(row).find(([key]) =>
      patterns.some((pattern) => pattern.test(key.trim().toLowerCase())),
    );

    return entry?.[1];
  }

  private extractVariants(row: Record<string, unknown>) {
    const buckets = new Map<string, Partial<ImportVariant>>();

    Object.entries(row).forEach(([rawKey, rawValue]) => {
      const key = rawKey.trim().toLowerCase();
      if (!key || /variant.*price/.test(key)) {
        return;
      }

      const nameMatch = key.match(/^variant(?:[_\s-]?name)?(?:[_\s-]?(\d+))?$/);
      const valueMatch = key.match(/^variant[_\s-]?value(?:[_\s-]?(\d+))?$/);

      if (nameMatch) {
        const token = nameMatch[1] ?? '1';
        const bucket = buckets.get(token) ?? {};
        bucket.variant_name = String(rawValue ?? '').trim();
        buckets.set(token, bucket);
        return;
      }

      if (valueMatch) {
        const token = valueMatch[1] ?? '1';
        const bucket = buckets.get(token) ?? {};
        bucket.variant_value = String(rawValue ?? '').trim();
        buckets.set(token, bucket);
      }
    });

    return Array.from(buckets.values())
      .filter(
        (variant): variant is ImportVariant =>
          !!variant.variant_name && !!variant.variant_value,
      );
  }

  private normalizeImportRows(rows: Record<string, unknown>[]) {
    const errors: string[] = [];
    const normalizedRows: ImportRow[] = [];

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const name = String(
        this.getRowValue(row, [/^name$/, /product name/, /item name/]) ?? '',
      ).trim();
      const description = String(
        this.getRowValue(row, [/^description$/, /details?/, /^note$/]) ?? '',
      ).trim();
      const sku = String(
        this.getRowValue(row, [/^sku$/, /product sku/, /code/]) ?? '',
      ).trim();
      const categoryName = String(
        this.getRowValue(row, [/^category$/, /category name/, /type/]) ?? '',
      ).trim();
      const priceRaw = this.getRowValue(row, [/^price$/, /amount/, /main price/]);
      const price = this.normalizePrice(priceRaw);
      const secondaryPrice1Raw = this.getRowValue(row, [/secondary price 1/, /secondary_price_1/]);
      const secondaryPrice2Raw = this.getRowValue(row, [/secondary price 2/, /secondary_price_2/]);
      const quantityRaw = this.getRowValue(row, [/^quantity$/, /stock/, /initial quantity/]);
      const statusRaw = this.getRowValue(row, [/^status$/, /stock status/]);
      const normalizedSecondaryPrice1 = this.normalizePrice(secondaryPrice1Raw);
      const normalizedSecondaryPrice2 = this.normalizePrice(secondaryPrice2Raw);
      const parsedQuantity = Number(String(quantityRaw ?? '').trim() || 0);
      const status = String(statusRaw ?? '').trim() || 'In Stock';
      const variants = this.extractVariants(row);
      const explicitHasVariants = this.getRowValue(row, [/has variants/, /^variants$/]);
      const hasVariants =
        explicitHasVariants !== undefined
          ? this.normalizeBoolean(explicitHasVariants)
          : variants.length > 0;

      if (!name) {
        errors.push(`Row ${rowNumber}: Product name is required.`);
      }
      if (!categoryName) {
        errors.push(`Row ${rowNumber}: Category is required.`);
      }
      if (!Number.isFinite(price)) {
        errors.push(`Row ${rowNumber}: Price must be a valid number.`);
      }
      if (hasVariants && !variants.length) {
        errors.push(
          `Row ${rowNumber}: Has variants is enabled but no variant_name/variant_value pairs were found.`,
        );
      }

      if (name && categoryName && Number.isFinite(price) && (!hasVariants || variants.length)) {
        normalizedRows.push({
          rowNumber,
          name,
          description,
          sku,
          price,
          secondaryPrice1: Number.isFinite(normalizedSecondaryPrice1)
            ? normalizedSecondaryPrice1
            : 0,
          secondaryPrice2: Number.isFinite(normalizedSecondaryPrice2)
            ? normalizedSecondaryPrice2
            : 0,
          quantity: Number.isFinite(parsedQuantity) ? parsedQuantity : 0,
          status,
          categoryName,
          hasVariants,
          variants,
        });
      }
    });

    if (errors.length) {
      throw new BadRequestException({
        message: 'Product import validation failed',
        errors,
      });
    }

    return normalizedRows;
  }

  async import(file: { buffer: Buffer } | undefined, user: AuthenticatedUser) {
    if (!file) {
      throw new BadRequestException('A CSV or Excel file is required');
    }

    const rawRows = this.readImportRows(file);
    const normalizedRows = this.normalizeImportRows(rawRows);
    const createdProducts: Product[] = [];

    for (const row of normalizedRows) {
      const category = await this.ensureCategoryByName(
        row.categoryName,
        user.company_id,
      );

      const product = await this.productRepository.save(
        this.productRepository.create({
          name: row.name,
          description: row.description,
          sku: row.sku,
          price: row.price,
          secondary_price_1: row.secondaryPrice1,
          secondary_price_2: row.secondaryPrice2,
          quantity: row.quantity,
          status: row.status,
          category_id: category.id,
          company_id: user.company_id,
          created_by: user.id,
          has_variants: row.hasVariants,
          is_deleted: false,
          category,
        }),
      );

      if (row.hasVariants && row.variants.length) {
        await this.productVariantRepository.save(
          this.buildVariantEntities(product, row.variants),
        );
      }

      createdProducts.push(await this.findOwnedProduct(product.id, user.company_id));
    }

    return {
      imported_count: createdProducts.length,
      items: createdProducts,
    };
  }
}
