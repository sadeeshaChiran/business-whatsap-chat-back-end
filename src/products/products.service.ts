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
type ImportVariant = {
  variant_name: string;
  variant_value: string;
  price?: number;
  quantity?: number;
  sku?: string;
  image_url?: string;
};

type ImportLine = {
  rowNumber: number;
  name: string;
  description: string;
  sku: string;
  price: number;
  quantity: number;
  status: string;
  categoryName: string;
  hasVariants: boolean;
  weight: number;
  gallery: string[];
  coverImageUrl: string;
  variant?: ImportVariant;
  legacyAttributeGroups?: Map<string, string[]>;
};

type ImportProductGroup = {
  rowNumbers: number[];
  name: string;
  description: string;
  sku: string;
  price: number;
  quantity: number;
  status: string;
  categoryName: string;
  hasVariants: boolean;
  weight: number;
  gallery: string[];
  coverImageUrl: string;
  variants: ImportVariant[];
};

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(ProductVariant)
    private readonly productVariantRepository: Repository<ProductVariant>,
    @InjectRepository(ProductCatergory)
    private readonly productCategoryRepository: Repository<ProductCatergory>,
  ) {}

  private normalizeGallery(gallery?: string[] | null): string[] {
    return (gallery ?? [])
      .map((url) => url.trim())
      .filter(Boolean);
  }

  private resolveCoverImage(
    coverImage: string | undefined | null,
    gallery: string[],
  ): string | null {
    const trimmedCover = (coverImage ?? '').trim();
    if (trimmedCover) {
      return trimmedCover;
    }

    return gallery[0] ?? null;
  }

  private validateProductMedia(
    gallery: string[],
    coverImage: string | null,
    weight: number | undefined | null,
  ) {
    if (!gallery.length) {
      throw new BadRequestException('Product images are required');
    }

    if (!coverImage) {
      throw new BadRequestException('Cover image is required');
    }

    if (weight === undefined || weight === null || Number(weight) < 0) {
      throw new BadRequestException('Product weight is required');
    }
  }

  private applyVariantDefaults(
    variants: ImportVariant[],
    basePrice: number,
  ): ImportVariant[] {
    return variants.map((variant) => ({
      ...variant,
      price:
        variant.price !== undefined && variant.price !== null
          ? Number(variant.price)
          : basePrice,
      quantity:
        variant.quantity !== undefined && variant.quantity !== null
          ? Number(variant.quantity)
          : 0,
      sku: variant.sku?.trim() ?? '',
    }));
  }

  private normalizeVariants(
    variants?: ImportVariant[],
    basePrice?: number,
  ) {
    const normalized = (variants ?? [])
      .map((variant) => {
        const normalizedVariant = {
          variant_name: variant.variant_name.trim(),
          variant_value: variant.variant_value.trim(),
        };

        if (!normalizedVariant.variant_name || !normalizedVariant.variant_value) {
          return null;
        }

        const withPricing: ImportVariant = { ...normalizedVariant };

        if (variant.price !== undefined && variant.price !== null) {
          withPricing.price = Number(variant.price);
        }
        if (variant.quantity !== undefined && variant.quantity !== null) {
          withPricing.quantity = Number(variant.quantity);
        }
        if (variant.sku?.trim()) {
          withPricing.sku = variant.sku.trim();
        }
        if (variant.image_url?.trim()) {
          withPricing.image_url = variant.image_url.trim();
        }

        return withPricing;
      })
      .filter((variant): variant is ImportVariant => variant !== null);

    if (basePrice === undefined) {
      return normalized;
    }

    return this.applyVariantDefaults(normalized, basePrice);
  }

  private async findProductEntity(id: number, companyId: number) {
    const product = await this.productRepository.findOne({
      where: { id, company_id: companyId, is_deleted: false },
      relations: ['category', 'variants'],
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  private async findOwnedProduct(id: number, companyId: number) {
    return this.toProductResponse(
      await this.findProductEntity(id, companyId),
    );
  }

  private toProductResponse(product: Product): Product {
    const variantRow = product.variants?.[0];
    const flatVariants = variantRow?.variants ?? [];

    return {
      ...product,
      variants: flatVariants as unknown as Product['variants'],
    };
  }

  private async saveProductVariants(
    product: Product,
    variants: ImportVariant[],
    hasVariants: boolean,
  ) {
    await this.productVariantRepository.delete({ product_id: product.id });

    const normalizedVariants = this.normalizeVariants(variants);
    if (hasVariants && normalizedVariants.length) {
      await this.productVariantRepository.save(
        this.productVariantRepository.create({
          product_id: product.id,
          product,
          variants: normalizedVariants,
        }),
      );
    }
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

  async create(createProductDto: CreateProductDto, user: AuthenticatedUser) {
    const category = await this.findCategoryForCompany(
      createProductDto.category_id,
      user.company_id,
    );

    const gallery = this.normalizeGallery(createProductDto.gallery);
    const coverImage = this.resolveCoverImage(
      createProductDto.image_url,
      gallery,
    );
    this.validateProductMedia(
      gallery,
      coverImage,
      createProductDto.weight,
    );

    const basePrice = Number(createProductDto.price);
    const normalizedVariants = this.normalizeVariants(
      createProductDto.variants,
      basePrice,
    );
    const hasVariants =
      createProductDto.has_variants ?? normalizedVariants.length > 0;

    const productQuantity = hasVariants
      ? normalizedVariants.reduce(
          (total, variant) => total + Number(variant.quantity ?? 0),
          0,
        )
      : Number(createProductDto.quantity ?? 0);

    const product = this.productRepository.create({
      name: createProductDto.name.trim(),
      description: createProductDto.description?.trim() ?? '',
      sku: hasVariants ? '' : (createProductDto.sku?.trim() ?? ''),
      price: basePrice,
      quantity: productQuantity,
      ...(createProductDto.status !== undefined
        ? { status: createProductDto.status.trim() || 'In Stock' }
        : {}),
      category_id: category.id,
      company_id: user.company_id,
      created_by: user.id,
      has_variants: hasVariants,
      image_url: coverImage,
      gallery,
      weight: Number(createProductDto.weight),
      is_deleted: false,
      category,
    });

    const savedProduct = await this.productRepository.save(product);

    await this.saveProductVariants(
      savedProduct,
      normalizedVariants,
      savedProduct.has_variants,
    );

    return this.findOwnedProduct(savedProduct.id, user.company_id);
  }

  async findAll(user: AuthenticatedUser, categoryId?: number) {
    const where = {
      company_id: user.company_id,
      is_deleted: false,
      ...(categoryId ? { category_id: categoryId } : {}),
    };

    const products = await this.productRepository.find({
      where,
      relations: ['category', 'variants'],
      order: { id: 'DESC' },
    });

    return products.map((product) => this.toProductResponse(product));
  }

  async findOne(id: number, user: AuthenticatedUser) {
    return this.findOwnedProduct(id, user.company_id);
  }

  async update(
    id: number,
    updateProductDto: UpdateProductDto,
    user: AuthenticatedUser,
  ) {
    const product = await this.findProductEntity(id, user.company_id);

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
    if (updateProductDto.price !== undefined) {
      product.price = Number(updateProductDto.price);
    }
    if (updateProductDto.status !== undefined) {
      product.status = updateProductDto.status?.trim() || 'In Stock';
    }

    const normalizedVariants = this.normalizeVariants(
      updateProductDto.variants,
      updateProductDto.price !== undefined
        ? Number(updateProductDto.price)
        : Number(product.price),
    );
    const hasVariants =
      updateProductDto.has_variants ?? (updateProductDto.variants !== undefined
        ? normalizedVariants.length > 0
        : product.has_variants);

    product.has_variants = hasVariants;

    const gallery =
      updateProductDto.gallery !== undefined
        ? this.normalizeGallery(updateProductDto.gallery)
        : this.normalizeGallery(product.gallery);
    const coverImage = this.resolveCoverImage(
      updateProductDto.image_url !== undefined
        ? updateProductDto.image_url
        : product.image_url,
      gallery,
    );
    const nextWeight =
      updateProductDto.weight !== undefined
        ? updateProductDto.weight
        : product.weight;

    if (
      updateProductDto.gallery !== undefined ||
      updateProductDto.image_url !== undefined ||
      updateProductDto.weight !== undefined
    ) {
      this.validateProductMedia(gallery, coverImage, nextWeight);
    }

    product.gallery = gallery;
    product.image_url = coverImage;
    if (updateProductDto.weight !== undefined) {
      product.weight = Number(updateProductDto.weight);
    }

    if (updateProductDto.sku !== undefined) {
      product.sku = hasVariants ? '' : (updateProductDto.sku?.trim() ?? '');
    } else if (hasVariants) {
      product.sku = '';
    }

    if (hasVariants && updateProductDto.variants !== undefined) {
      product.quantity = normalizedVariants.reduce(
        (total, variant) => total + Number(variant.quantity ?? 0),
        0,
      );
    } else if (!hasVariants && updateProductDto.quantity !== undefined) {
      product.quantity = Number(updateProductDto.quantity ?? 0);
    }

    const savedProduct = await this.productRepository.save(product);

    if (updateProductDto.variants !== undefined || updateProductDto.has_variants !== undefined) {
      await this.saveProductVariants(savedProduct, normalizedVariants, hasVariants);
    }

    return this.findOwnedProduct(savedProduct.id, user.company_id);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const product = await this.findProductEntity(id, user.company_id);
    product.is_deleted = true;
    await this.productRepository.save(product);

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

    if (!cleaned) {
      return NaN;
    }

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  private getRowValue(row: Record<string, unknown>, patterns: RegExp[]) {
    const entry = Object.entries(row).find(([key]) =>
      patterns.some((pattern) => pattern.test(key.trim().toLowerCase())),
    );

    return entry?.[1];
  }

  private parseGalleryUrls(value: unknown): string[] {
    return String(value ?? '')
      .split(/[;|]/)
      .map((url) => url.trim())
      .filter(Boolean);
  }

  private productImportKey(name: string, categoryName: string): string {
    return `${name.trim().toLowerCase()}|${categoryName.trim().toLowerCase()}`;
  }

  private buildCombinationsFromAttributeGroups(
    groups: Map<string, string[]>,
  ): ImportVariant[] {
    const normalized = Array.from(groups.entries())
      .map(([name, values]) => ({
        name: name.trim(),
        values: values.map((value) => value.trim()).filter(Boolean),
      }))
      .filter((group) => group.name && group.values.length);

    if (!normalized.length) {
      return [];
    }

    let combinations: Array<Record<string, string>> = [{}];
    normalized.forEach((group) => {
      combinations = combinations.flatMap((current) =>
        group.values.map((value) => ({
          ...current,
          [group.name]: value,
        })),
      );
    });

    return combinations.map((parts) => {
      const names = Object.keys(parts);
      return {
        variant_name: names.join(' / '),
        variant_value: names.map((name) => parts[name]).join(' / '),
      };
    });
  }

  private extractLegacyAttributeGroups(row: Record<string, unknown>) {
    const groups = new Map<string, Set<string>>();

    this.extractLegacyVariantPairs(row).forEach((pair) => {
      if (!groups.has(pair.variant_name)) {
        groups.set(pair.variant_name, new Set());
      }
      groups.get(pair.variant_name)!.add(pair.variant_value);
    });

    const normalized = new Map<string, string[]>();
    groups.forEach((values, name) => {
      normalized.set(name, Array.from(values.values()));
    });
    return normalized;
  }

  private extractLegacyVariantPairs(row: Record<string, unknown>) {
    const buckets = new Map<string, Partial<ImportVariant>>();

    Object.entries(row).forEach(([rawKey, rawValue]) => {
      const key = rawKey.trim().toLowerCase();
      if (!key || /variant.*price|variant.*qty|variant.*sku|variant.*image/.test(key)) {
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

    return Array.from(buckets.values()).filter(
      (variant): variant is ImportVariant =>
        !!variant.variant_name && !!variant.variant_value,
    );
  }

  private extractVariantCombinationFromRow(
    row: Record<string, unknown>,
  ): ImportVariant | null {
    const variantName = String(
      this.getRowValue(row, [
        /^variant_name$/,
        /variant name/,
        /^combination_name$/,
      ]) ?? '',
    ).trim();
    const variantValue = String(
      this.getRowValue(row, [
        /^variant_value$/,
        /variant value/,
        /^combination_value$/,
      ]) ?? '',
    ).trim();

    if (!variantName || !variantValue) {
      return null;
    }

    const variant: ImportVariant = {
      variant_name: variantName,
      variant_value: variantValue,
    };

    const variantPrice = this.normalizePrice(
      this.getRowValue(row, [/variant[_\s-]?price/, /^variant price$/]),
    );
    if (Number.isFinite(variantPrice)) {
      variant.price = variantPrice;
    }

    const variantQuantityRaw = this.getRowValue(row, [
      /variant[_\s-]?qty/,
      /variant[_\s-]?quantity/,
      /variant stock/,
    ]);
    const variantQuantity = Number(String(variantQuantityRaw ?? '').trim() || NaN);
    if (Number.isFinite(variantQuantity)) {
      variant.quantity = variantQuantity;
    }

    const variantSku = String(
      this.getRowValue(row, [/variant[_\s-]?sku/, /^variant sku$/]) ?? '',
    ).trim();
    if (variantSku) {
      variant.sku = variantSku;
    }

    const variantImageUrl = String(
      this.getRowValue(row, [
        /variant[_\s-]?image[_\s-]?url/,
        /variant image/,
        /variant_image/,
      ]) ?? '',
    ).trim();
    if (variantImageUrl) {
      variant.image_url = variantImageUrl;
    }

    return variant;
  }

  private normalizeImportLine(
    row: Record<string, unknown>,
    rowNumber: number,
  ): ImportLine {
    const name = String(
      this.getRowValue(row, [/^name$/, /product name/, /item name/]) ?? '',
    ).trim();
    const description = String(
      this.getRowValue(row, [/^description$/, /details?/, /^note$/]) ?? '',
    ).trim();
    const sku = String(
      this.getRowValue(row, [/^sku$/, /product sku/, /^code$/]) ?? '',
    ).trim();
    const categoryName = String(
      this.getRowValue(row, [/^category$/, /category name/, /type/]) ?? '',
    ).trim();
    const priceRaw = this.getRowValue(row, [
      /^price$/,
      /amount/,
      /main price/,
      /base price/,
      /base_price/,
    ]);
    const price = this.normalizePrice(priceRaw);
    const quantityRaw = this.getRowValue(row, [
      /^quantity$/,
      /stock/,
      /initial quantity/,
      /base stock/,
      /base_stock/,
    ]);
    const statusRaw = this.getRowValue(row, [/^status$/, /stock status/]);
    const weightRaw = this.getRowValue(row, [/^weight$/, /weight \(kg\)/, /product weight/]);
    const weight = this.normalizePrice(weightRaw);
    const gallery = this.parseGalleryUrls(
      this.getRowValue(row, [
        /gallery_urls/,
        /gallery url/,
        /^gallery$/,
        /product_images/,
        /product images/,
      ]),
    );
    const coverImageUrl = String(
      this.getRowValue(row, [
        /cover_image_url/,
        /cover image/,
        /^cover_image$/,
        /image_url/,
        /main image/,
      ]) ?? '',
    ).trim();
    const parsedQuantity = Number(String(quantityRaw ?? '').trim() || 0);
    const status = String(statusRaw ?? '').trim() || 'In Stock';
    const variant = this.extractVariantCombinationFromRow(row);
    const legacyAttributeGroups = this.extractLegacyAttributeGroups(row);
    const explicitHasVariants = this.getRowValue(row, [/has variants/, /^variants$/]);
    const hasVariants =
      explicitHasVariants !== undefined
        ? this.normalizeBoolean(explicitHasVariants)
        : !!variant || legacyAttributeGroups.size > 0;

    return {
      rowNumber,
      name,
      description,
      sku,
      price,
      quantity: Number.isFinite(parsedQuantity) ? parsedQuantity : 0,
      status,
      categoryName,
      hasVariants,
      weight,
      gallery,
      coverImageUrl,
      ...(variant ? { variant } : {}),
      ...(legacyAttributeGroups.size ? { legacyAttributeGroups } : {}),
    };
  }

  private groupImportLines(lines: ImportLine[]) {
    const errors: string[] = [];
    const groups = new Map<string, ImportProductGroup>();

    lines.forEach((line) => {
      if (!line.name) {
        errors.push(`Row ${line.rowNumber}: Product name is required.`);
        return;
      }
      if (!line.categoryName) {
        errors.push(`Row ${line.rowNumber}: Category is required.`);
        return;
      }
      const key = this.productImportKey(line.name, line.categoryName);
      const existing = groups.get(key);
      const isVariantContinuation = !!existing && !!line.variant;

      if (!Number.isFinite(line.price) && !isVariantContinuation) {
        errors.push(`Row ${line.rowNumber}: Base price must be a valid number.`);
        return;
      }

      if (!existing) {
        groups.set(key, {
          rowNumbers: [line.rowNumber],
          name: line.name,
          description: line.description,
          sku: line.sku,
          price: line.price,
          quantity: line.quantity,
          status: line.status,
          categoryName: line.categoryName,
          hasVariants: line.hasVariants,
          weight: line.weight,
          gallery: [...line.gallery],
          coverImageUrl: line.coverImageUrl,
          variants: [],
        });
      } else {
        existing.rowNumbers.push(line.rowNumber);
        if (line.description) existing.description = line.description;
        if (line.sku) existing.sku = line.sku;
        if (Number.isFinite(line.price)) existing.price = line.price;
        if (line.quantity) existing.quantity = line.quantity;
        if (line.status) existing.status = line.status;
        if (line.hasVariants) existing.hasVariants = true;
        if (Number.isFinite(line.weight)) existing.weight = line.weight;
        if (line.gallery.length) {
          existing.gallery = Array.from(new Set([...existing.gallery, ...line.gallery]));
        }
        if (line.coverImageUrl) existing.coverImageUrl = line.coverImageUrl;
      }

      const group = groups.get(key)!;

      if (line.variant) {
        const variantKey = `${line.variant.variant_name}:${line.variant.variant_value}`;
        const alreadyAdded = group.variants.some(
          (variant) =>
            `${variant.variant_name}:${variant.variant_value}` === variantKey,
        );
        if (!alreadyAdded) {
          group.variants.push(line.variant);
        }
      } else if (
        line.legacyAttributeGroups?.size &&
        !group.variants.length &&
        group.rowNumbers.length === 1
      ) {
        group.variants = this.buildCombinationsFromAttributeGroups(
          line.legacyAttributeGroups,
        );
      }
    });

    groups.forEach((group) => {
      const rowLabel = group.rowNumbers.join(', ');
      const gallery =
        group.gallery.length > 0
          ? group.gallery
          : group.coverImageUrl
            ? [group.coverImageUrl]
            : [];
      const coverImage = this.resolveCoverImage(group.coverImageUrl, gallery);

      if (!Number.isFinite(group.weight) || group.weight < 0) {
        errors.push(
          `Rows ${rowLabel}: Product weight is required for delivery calculations.`,
        );
      }
      if (!Number.isFinite(group.price)) {
        errors.push(`Rows ${rowLabel}: Base price must be a valid number.`);
      }
      if (!gallery.length) {
        errors.push(`Rows ${rowLabel}: Product images are required (gallery_urls).`);
      }
      if (!coverImage) {
        errors.push(`Rows ${rowLabel}: Cover image is required.`);
      }

      if (group.hasVariants && !group.variants.length) {
        errors.push(
          `Rows ${rowLabel}: Has variants is enabled but no variant combinations were found.`,
        );
      }

      group.variants.forEach((variant) => {
        const imageUrl = variant.image_url?.trim();
        if (imageUrl && !gallery.includes(imageUrl)) {
          errors.push(
            `Rows ${rowLabel}: Variant "${variant.variant_value}" image must be selected from gallery_urls.`,
          );
        }
      });

      group.gallery = gallery;
      group.coverImageUrl = coverImage ?? '';
    });

    if (errors.length) {
      throw new BadRequestException(errors.join('; '));
    }

    return Array.from(groups.values());
  }

  private normalizeImportRows(rows: Record<string, unknown>[]) {
    const lines = rows
      .map((row, index) => this.normalizeImportLine(row, index + 2))
      .filter(
        (line) =>
          Boolean(
            line.name.trim() ||
              line.categoryName.trim() ||
              line.variant ||
              line.legacyAttributeGroups?.size ||
              line.gallery.length ||
              line.coverImageUrl,
          ),
      );

    return this.groupImportLines(lines);
  }

  private async persistImportGroup(
    group: ImportProductGroup,
    user: AuthenticatedUser,
  ) {
    const category = await this.ensureCategoryByName(
      group.categoryName,
      user.company_id,
    );

    const normalizedVariants = this.normalizeVariants(
      group.variants,
      group.price,
    );
    const hasVariants = group.hasVariants && normalizedVariants.length > 0;
    const gallery = this.normalizeGallery(group.gallery);
    const coverImage = this.resolveCoverImage(group.coverImageUrl, gallery);

    this.validateProductMedia(gallery, coverImage, group.weight);

    const productQuantity = hasVariants
      ? normalizedVariants.reduce(
          (total, variant) => total + Number(variant.quantity ?? 0),
          0,
        )
      : group.quantity;

    const product = await this.productRepository.save(
      this.productRepository.create({
        name: group.name,
        description: group.description,
        sku: hasVariants ? '' : group.sku,
        price: group.price,
        quantity: productQuantity,
        status: group.status,
        category_id: category.id,
        company_id: user.company_id,
        created_by: user.id,
        has_variants: hasVariants,
        image_url: coverImage,
        gallery,
        weight: Number(group.weight),
        is_deleted: false,
        category,
      }),
    );

    if (hasVariants) {
      await this.saveProductVariants(product, normalizedVariants, hasVariants);
    }

    return this.findOwnedProduct(product.id, user.company_id);
  }

  async import(file: { buffer: Buffer } | undefined, user: AuthenticatedUser) {
    if (!file) {
      throw new BadRequestException('A CSV or Excel file is required');
    }

    const rawRows = this.readImportRows(file);
    const groupedRows = this.normalizeImportRows(rawRows);
    const createdProducts: Product[] = [];

    for (const group of groupedRows) {
      createdProducts.push(await this.persistImportGroup(group, user));
    }

    return {
      imported_count: createdProducts.length,
      items: createdProducts,
    };
  }
}
