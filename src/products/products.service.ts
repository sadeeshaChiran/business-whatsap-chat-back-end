import { PlanService } from '../platform/plan.service';
import {
  BadRequestException,
  Optional,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as XLSX from 'xlsx';
import { Brackets, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Company } from '../company/entities/company.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductVariant } from './entities/product-variant.entity';
import { Product } from './entities/product.entity';
import { ProductCatergory } from './product_catergory/entities/product_catergory.entity';
import { MAX_PRODUCT_IMAGE_BYTES, absoluteProductImage, readOwnProductImage, storeIfDataUrl } from './product-images';
import { Logger, OnModuleInit } from '@nestjs/common';
type ImportVariant = {
  variant_name: string;
  variant_value: string;
  price?: number;
  quantity?: number;
  sku?: string;
  image_url?: string;
  use_default_image?: boolean;
  weight?: number;
  available?: boolean;
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
  sellingPoints?: string;
  showToBot?: boolean;
  available?: boolean;
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
  sellingPoints?: string;
  showToBot?: boolean;
  available?: boolean;
  variants: ImportVariant[];
};

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(ProductVariant)
    private readonly productVariantRepository: Repository<ProductVariant>,
    @InjectRepository(ProductCatergory)
    private readonly productCategoryRepository: Repository<ProductCatergory>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @Optional() private readonly planService?: PlanService,
  ) {}

  /** Old products kept their photos as long "data:image/…" text – move them once into files with short full links. */
  onModuleInit() {
    setTimeout(() => void this.moveInlinePhotos()
      .catch((error: unknown) => this.logger.warn(`moving inline product photos failed: ${error instanceof Error ? error.message : String(error)}`))
      .then(() => this.describeMissingPhotos())
      .catch(() => undefined), 5000).unref();
  }

  /**
   * The AI looks at the first photo and writes one line about it (colour, pattern, style) into product.image_notes,
   * so the sales bot can find the product when a customer sends a photo. Runs in the background; needs SALES_BOT_URL.
   */
  describePhotosLater(productId: number) {
    void this.fingerprintPhotos(productId).catch((error: unknown) =>
      this.logger.warn(`fingerprinting product ${productId} photos failed: ${error instanceof Error ? error.message : String(error)}`));
    void this.describePhotos(productId).catch((error: unknown) =>
      this.logger.warn(`describing product ${productId} photo failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Bytes of a product photo: our own stored file from disk, anything else downloaded (max 8 MB). */
  private async photoBytes(url: string): Promise<{ buffer: Buffer; mimetype: string } | null> {
    const own = readOwnProductImage(url);
    if (own) return own;
    const link = absoluteProductImage(url);
    if (!/^https?:\/\//i.test(link)) return null;
    const response = await fetch(link, { signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!response?.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null;
    return { buffer, mimetype: (response.headers.get('content-type') || 'image/jpeg').split(';')[0] };
  }

  /**
   * Perceptual fingerprints of every photo of the product (cover, gallery, option photos) – no AI, no cost.
   * When a customer sends one of these photos back (screenshot, forwarded, cropped) the bot knows the product for sure.
   */
  async fingerprintPhotos(productId: number, force = false): Promise<number> {
    const base = String(process.env.SALES_BOT_URL ?? '').trim().replace(/\/+$/, '');
    if (!base) return 0;
    const [row]: Array<{ image_url: string | null; gallery: string[] | null; variant_image_match: { images?: Record<string, string> } | null; image_hashes_src: string | null }> =
      await this.productRepository.query(`SELECT image_url, gallery, variant_image_match, image_hashes_src FROM product WHERE id = $1`, [productId]);
    if (!row) return 0;
    const variantRows: Array<{ image_url: string | null }> = await this.productRepository.query(
      `SELECT elem->>'image_url' AS image_url FROM product_variant v, jsonb_array_elements(COALESCE(v.variants, '[]'::jsonb)) elem
        WHERE v.product_id = $1 AND COALESCE(elem->>'image_url', '') <> ''`, [productId]).catch(() => []);
    const urls = [...new Set([row.image_url, ...(row.gallery ?? []), ...Object.values(row.variant_image_match?.images ?? {}), ...variantRows.map((v) => v.image_url)]
      .map((u) => String(u ?? '').trim()).filter((u) => /^https?:\/\//i.test(u) || u.includes('/public/product-images/')))].slice(0, 12);
    const signature = urls.join('|');
    if (!force && row.image_hashes_src === signature) return 0;
    if (!urls.length) {
      await this.productRepository.query(`UPDATE product SET image_hashes = '[]'::jsonb, image_hashes_src = '' WHERE id = $1`, [productId]);
      return 0;
    }
    const files = await Promise.all(urls.map((url) => this.photoBytes(url).catch(() => null)));
    const images = files.map((file) => ({ image_b64: file ? file.buffer.toString('base64') : '', mime_type: file?.mimetype ?? 'image/jpeg' }));
    const response = await fetch(`${base}/photos/fingerprint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Key': String(process.env.SALES_BOT_API_KEY ?? '') },
      body: JSON.stringify({ images: images.filter((i) => i.image_b64) }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`fingerprint service answered ${response.status}`);
    const hashes = ((await response.json()) as { hashes?: Array<Array<{ p: string; d: string; c: string }>> }).hashes ?? [];
    const readable = urls.filter((_, index) => images[index].image_b64);
    const stored = readable.map((url, index) => ({ url, hashes: hashes[index] ?? [] })).filter((item) => item.hashes.length);
    await this.productRepository.query(`UPDATE product SET image_hashes = $2::jsonb, image_hashes_src = $3 WHERE id = $1`,
      [productId, JSON.stringify(stored), signature]);
    return stored.length;
  }

  async describePhotos(productId: number, force = false): Promise<string | null> {
    const base = String(process.env.SALES_BOT_URL ?? '').trim().replace(/\/+$/, '');
    if (!base) return null;
    const [row]: Array<{ id: number; name: string; image_url: string | null; gallery: string[] | null; image_notes: string | null; image_notes_src: string | null }> =
      await this.productRepository.query(`SELECT id, name, image_url, gallery, image_notes, image_notes_src FROM product WHERE id = $1`, [productId]);
    if (!row) return null;
    const url = [row.image_url, ...(row.gallery ?? [])].map((u) => String(u ?? '').trim()).find((u) => /^https?:\/\//i.test(u) || u.includes('/public/product-images/'));
    if (!url) {
      if (row.image_notes) await this.productRepository.query(`UPDATE product SET image_notes = NULL, image_notes_src = NULL WHERE id = $1`, [productId]);
      return null;
    }
    if (!force && row.image_notes && row.image_notes_src === url) return row.image_notes; // same photo – nothing to do
    let file = readOwnProductImage(url);
    if (!file) {
      const response = await fetch(absoluteProductImage(url), { signal: AbortSignal.timeout(20000) });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_PRODUCT_IMAGE_BYTES * 2) return null;
      file = { buffer, mimetype: (response.headers.get('content-type') || 'image/jpeg').split(';')[0] };
    }
    const reply = await fetch(`${base}/products/describe-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Key': String(process.env.SALES_BOT_API_KEY ?? '') },
      body: JSON.stringify({ image_b64: file.buffer.toString('base64'), mime_type: file.mimetype, name: row.name }),
      signal: AbortSignal.timeout(60000),
    });
    if (!reply.ok) return null;
    const notes = String(((await reply.json()) as { description?: string }).description ?? '').trim().slice(0, 300);
    if (!notes) return null;
    await this.productRepository.query(`UPDATE product SET image_notes = $2, image_notes_src = $3 WHERE id = $1`, [productId, notes, url]);
    return notes;
  }

  /** Products with photos but no AI photo description yet (a few per start, so the cost stays small). */
  private async describeMissingPhotos() {
    if (!String(process.env.SALES_BOT_URL ?? '').trim()) return;
    // fingerprints first (no AI cost): every product with photos, 50 at a time
    for (let round = 0; round < 60; round++) {
      const pending: Array<{ id: number }> = await this.productRepository.query(`
        SELECT id FROM product WHERE COALESCE(is_deleted, FALSE) = FALSE AND image_hashes IS NULL
           AND (COALESCE(image_url, '') <> '' OR jsonb_array_length(COALESCE(gallery, '[]'::jsonb)) > 0)
         ORDER BY id DESC LIMIT 50`).catch(() => []);
      if (!pending.length) break;
      for (const item of pending) {
        const done = await this.fingerprintPhotos(item.id).catch(() => -1);
        if (done < 0) await this.productRepository.query(`UPDATE product SET image_hashes = '[]'::jsonb WHERE id = $1`, [item.id]).catch(() => undefined);
      }
    }
    const rows: Array<{ id: number }> = await this.productRepository.query(`
      SELECT id FROM product WHERE COALESCE(is_deleted, FALSE) = FALSE AND image_notes IS NULL
         AND (COALESCE(image_url, '') <> '' OR jsonb_array_length(COALESCE(gallery, '[]'::jsonb)) > 0)
       ORDER BY id DESC LIMIT 30`).catch(() => []);
    for (const row of rows) await this.describePhotos(row.id).catch(() => null);
  }

  async moveInlinePhotos(): Promise<number> {
    const rows: Array<{ id: number; company_id: number; image_url: string | null; gallery: string[] | null; variant_image_match: { dimensions?: string[]; images?: Record<string, string> } | null }> =
      await this.productRepository.query(`
        SELECT id, company_id, image_url, gallery, variant_image_match FROM product
         WHERE image_url LIKE 'data:%' OR gallery::text LIKE '%data:image%' OR variant_image_match::text LIKE '%data:image%' LIMIT 500`);
    let moved = 0;
    for (const row of rows) {
      const cache = new Map<string, string>(); // the same picture is often the cover AND in the gallery
      const store = (value: string | null | undefined) => {
        const text = String(value ?? '').trim();
        if (!text.startsWith('data:')) return text;
        if (!cache.has(text)) { try { cache.set(text, storeIfDataUrl(row.company_id, text)); } catch { cache.set(text, ''); } }
        return cache.get(text) as string;
      };
      const gallery = (row.gallery ?? []).map(store).filter(Boolean);
      const images = row.variant_image_match?.images ? Object.fromEntries(Object.entries(row.variant_image_match.images).map(([k, v]) => [k, store(v)])) : null;
      await this.productRepository.query(`UPDATE product SET image_url = $2, gallery = $3::jsonb, variant_image_match = $4::jsonb WHERE id = $1`,
        [row.id, store(row.image_url) || gallery[0] || null, JSON.stringify(gallery), row.variant_image_match ? JSON.stringify({ ...row.variant_image_match, images }) : null]);
      moved++;
    }
    // option photos live in product_variant.variants (JSON list of options)
    const variantRows: Array<{ id: number; company_id: number; variants: Array<Record<string, unknown>> }> = await this.productRepository.query(`
      SELECT v.id, p.company_id, v.variants FROM product_variant v JOIN product p ON p.id = v.product_id
       WHERE v.variants::text LIKE '%data:image%' LIMIT 1000`).catch(() => []);
    for (const v of variantRows) {
      try {
        const options = (v.variants ?? []).map((option) => {
          const url = String(option.image_url ?? '');
          if (!url.startsWith('data:')) return option;
          try { return { ...option, image_url: storeIfDataUrl(v.company_id, url) }; } catch { return { ...option, image_url: '' }; }
        });
        await this.productRepository.query(`UPDATE product_variant SET variants = $2::jsonb WHERE id = $1`, [v.id, JSON.stringify(options)]);
        moved++;
      } catch { /* skip a broken picture */ }
    }
    if (moved) this.logger.log(`moved ${moved} inline product photos to files`);
    return moved;
  }

  /** Photos that come as "data:image/…" (pasted, older app) are stored as files – the product keeps a short full link. */
  private storeDtoImages(companyId: number, dto: CreateProductDto | UpdateProductDto) {
    const cache = new Map<string, string>();
    const store = (value: string | undefined | null) => {
      const text = String(value ?? '').trim();
      if (!text.startsWith('data:')) return text;
      if (!cache.has(text)) cache.set(text, storeIfDataUrl(companyId, text));
      return cache.get(text) as string;
    };
    if (dto.gallery) dto.gallery = dto.gallery.map(store).filter(Boolean);
    if (dto.image_url !== undefined) dto.image_url = store(dto.image_url) || undefined;
    for (const variant of dto.variants ?? []) if (variant.image_url) variant.image_url = store(variant.image_url);
    if (dto.variant_image_match?.images) {
      dto.variant_image_match.images = Object.fromEntries(Object.entries(dto.variant_image_match.images).map(([k, v]) => [k, store(v)]));
    }
  }

  /** Own product code (SKU): unique in the company. Empty = automatic "SKU-<id>". */
  private async assertSkuFree(companyId: number, sku: string, productId?: number) {
    const [taken] = await this.productRepository.query(
      `SELECT id FROM product WHERE company_id = $1 AND LOWER(sku) = LOWER($2) AND is_deleted = FALSE AND ($3::int IS NULL OR id <> $3) LIMIT 1`,
      [companyId, sku, productId ?? null]);
    if (taken) throw new BadRequestException(`The product code "${sku}" is already used by another product.`);
  }

  /** Package limit: max products (null = unlimited). */
  private async assertProductRoom(companyId: number, adding: number) {
    if (!this.planService || adding <= 0) return;
    const limits = await this.planService.limitsForCompany(companyId);
    if (limits.max_products == null) return;
    const current = await this.productRepository.count({ where: { company_id: companyId, is_deleted: false } as never });
    if (current + adding > limits.max_products) {
      // suggest a HIGHER package (more expensive than the current one) that allows more products
      const currentPrice = Number(limits.package?.price_monthly ?? 0);
      const upgrade = (await this.planService.packages())
        .filter((p) => p.is_active && p.is_public && p.id !== limits.package?.id && Number(p.price_monthly) > currentPrice
          && (p.max_products == null || p.max_products > limits.max_products!))
        .sort((a, b) => Number(a.price_monthly) - Number(b.price_monthly))[0];
      throw new ForbiddenException({
        statusCode: 403, error: 'Forbidden', code: 'LIMIT_REACHED', feature: 'max_products', upgrade_to: upgrade?.name ?? null,
        message: `Your ${limits.package?.name ?? ''} package allows ${limits.max_products} products (you have ${current}` +
          `${adding > 1 ? `, adding ${adding}` : ''}).${upgrade ? ` Upgrade to ${upgrade.name} for more.` : ''}`,
      });
    }
  }

  private async assertProductBusiness(companyId: number) {
    const company = await this.companyRepository.findOne({ where: { id: companyId } });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    if (company.business_category === 'service') {
      // A service business can still sell products when the sales bot setting says products / both
      const [settings] = await this.companyRepository.manager
        .query(`SELECT sells FROM bot_sales_settings WHERE company_id = $1`, [companyId])
        .catch(() => [] as Array<{ sells: string }>);
      if (!['products', 'both'].includes(String(settings?.sells ?? ''))) {
        throw new ForbiddenException('Products are not available for service-based businesses');
      }
    }
  }

  private normalizeGallery(gallery?: string[] | null): string[] {
    return (gallery ?? [])
      .map((url) => url.trim())
      .filter(Boolean);
  }

  private buildProductSku(productId: number): string {
    return `SKU-${productId}`;
  }

  private slugifyVariantSkuPart(value: string): string {
    return value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  private buildVariantSku(
    productId: number,
    variantValue: string,
    index: number,
  ): string {
    const parts = variantValue
      .split(' / ')
      .map((part) => this.slugifyVariantSkuPart(part))
      .filter(Boolean);
    const suffix = parts.length ? parts.join('-') : `V${index + 1}`;
    return `SKU-${productId}-${suffix}`;
  }

  private ensureVariantSkus(
    productId: number,
    variants: ImportVariant[],
  ): ImportVariant[] {
    return variants.map((variant, index) => ({
      ...variant,
      sku: this.buildVariantSku(productId, variant.variant_value, index),
    }));
  }

  private async ensureProductSku(product: Product): Promise<Product> {
    if (product.sku?.trim()) return product; // own code given
    const nextSku = this.buildProductSku(product.id);
    if (product.sku === nextSku) {
      return product;
    }
    product.sku = nextSku;
    return this.productRepository.save(product);
  }

  private normalizeVariantImageMatch(
    match?: { dimensions?: string[]; images?: Record<string, string> } | null,
  ) {
    if (!match) {
      return null;
    }
    const dimensions = (match.dimensions ?? [])
      .map((dimension) => dimension.trim())
      .filter(Boolean);
    const images: Record<string, string> = {};
    for (const [key, value] of Object.entries(match.images ?? {})) {
      const normalizedKey = key.trim();
      const normalizedValue = String(value ?? '').trim();
      if (normalizedKey && normalizedValue) {
        images[normalizedKey] = normalizedValue;
      }
    }
    if (!dimensions.length || !Object.keys(images).length) {
      return null;
    }
    return { dimensions, images };
  }

  private normalizeVariantPriceMatch(
    match?: { dimensions?: string[]; prices?: Record<string, number> } | null,
  ) {
    if (!match) {
      return null;
    }
    const dimensions = (match.dimensions ?? [])
      .map((dimension) => dimension.trim())
      .filter(Boolean);
    const prices: Record<string, number> = {};
    for (const [key, value] of Object.entries(match.prices ?? {})) {
      const normalizedKey = key.trim();
      const normalizedValue = Number(value);
      if (normalizedKey && Number.isFinite(normalizedValue) && normalizedValue >= 0) {
        prices[normalizedKey] = normalizedValue;
      }
    }
    if (!dimensions.length || !Object.keys(prices).length) {
      return null;
    }
    return { dimensions, prices };
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

  /** Weight is optional (only needed when delivery is charged by weight). */
  private validateProductWeight(weight: number | undefined | null) {
    if (weight !== undefined && weight !== null && (!Number.isFinite(Number(weight)) || Number(weight) < 0)) {
      throw new BadRequestException('Weight must be 0 or more (kg).');
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
        if (variant.weight !== undefined && variant.weight !== null && Number.isFinite(Number(variant.weight)) && Number(variant.weight) >= 0) {
          withPricing.weight = Number(variant.weight);
        }
        if (variant.available === false) {
          withPricing.available = false;
        }
        if (variant.image_url?.trim()) {
          withPricing.image_url = variant.image_url.trim();
          withPricing.use_default_image = false;
        } else if (variant.use_default_image !== undefined) {
          withPricing.use_default_image = Boolean(variant.use_default_image);
        }

        return withPricing;
      })
      .filter((variant): variant is ImportVariant => variant !== null);

    if (basePrice === undefined) {
      return normalized;
    }

    return this.applyVariantDefaults(normalized, basePrice);
  }

  /** Add-on products must be other, existing products of the same company. */
  private async normalizeRelatedProductIds(ids: number[] | undefined, companyId: number, selfId?: number) {
    const wanted = [...new Set((ids ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0 && id !== selfId))];
    if (!wanted.length) return [];
    const rows = await this.productRepository.find({
      select: { id: true },
      where: wanted.map((id) => ({ id, company_id: companyId, is_deleted: false })),
    });
    const found = new Set(rows.map((row) => row.id));
    return wanted.filter((id) => found.has(id)).slice(0, 10);
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

    const normalizedVariants = this.ensureVariantSkus(
      product.id,
      this.normalizeVariants(variants),
    );
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
    await this.assertProductRoom(Number(user.company_id), 1);
    await this.assertProductBusiness(user.company_id);

    const category = await this.findCategoryForCompany(
      createProductDto.category_id,
      user.company_id,
    );

    this.storeDtoImages(Number(user.company_id), createProductDto);
    const ownSku = String(createProductDto.sku ?? '').trim();
    if (ownSku) await this.assertSkuFree(Number(user.company_id), ownSku);
    const gallery = this.normalizeGallery(createProductDto.gallery);
    const coverImage = this.resolveCoverImage(
      createProductDto.image_url,
      gallery,
    );
    this.validateProductWeight(createProductDto.weight);

    const basePrice = Number(createProductDto.price ?? 0);
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
      sku: ownSku,
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
      weight: createProductDto.weight != null ? Number(createProductDto.weight) : null,
      selling_points: createProductDto.selling_points?.trim() ?? '',
      related_product_ids: await this.normalizeRelatedProductIds(createProductDto.related_product_ids, user.company_id),
      show_to_bot: createProductDto.show_to_bot ?? true,
      is_available: createProductDto.is_available ?? true,
      variant_image_match: this.normalizeVariantImageMatch(
        createProductDto.variant_image_match,
      ),
      variant_price_match: this.normalizeVariantPriceMatch(
        createProductDto.variant_price_match,
      ),
      is_deleted: false,
      category,
    });

    const savedProduct = await this.productRepository.save(product);

    await this.ensureProductSku(savedProduct);

    await this.saveProductVariants(
      savedProduct,
      normalizedVariants,
      savedProduct.has_variants,
    );

    this.describePhotosLater(savedProduct.id);
    return this.findOwnedProduct(savedProduct.id, user.company_id);
  }

  async findAll(user: AuthenticatedUser, categoryId?: number) {
    await this.assertProductBusiness(user.company_id);

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
    await this.assertProductBusiness(user.company_id);

    return this.findOwnedProduct(id, user.company_id);
  }

  async update(
    id: number,
    updateProductDto: UpdateProductDto,
    user: AuthenticatedUser,
  ) {
    await this.assertProductBusiness(user.company_id);

    const product = await this.findProductEntity(id, user.company_id);
    this.storeDtoImages(Number(user.company_id), updateProductDto);
    if (updateProductDto.sku !== undefined) {
      const ownSku = String(updateProductDto.sku ?? '').trim();
      if (ownSku) await this.assertSkuFree(Number(user.company_id), ownSku, product.id);
      product.sku = ownSku;
    }

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
    if (updateProductDto.selling_points !== undefined) {
      product.selling_points = updateProductDto.selling_points?.trim() ?? '';
    }
    if (updateProductDto.related_product_ids !== undefined) {
      product.related_product_ids = await this.normalizeRelatedProductIds(updateProductDto.related_product_ids, user.company_id, product.id);
    }
    if (updateProductDto.is_available !== undefined) {
      product.is_available = updateProductDto.is_available;
    }
    if (updateProductDto.show_to_bot !== undefined) {
      product.show_to_bot = updateProductDto.show_to_bot;
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
      if (updateProductDto.weight !== undefined) {
        this.validateProductWeight(nextWeight);
      }
    }

    product.gallery = gallery;
    product.image_url = coverImage;
    if (updateProductDto.weight !== undefined) {
      product.weight = updateProductDto.weight != null ? Number(updateProductDto.weight) : null;
    }

    if (updateProductDto.variant_image_match !== undefined) {
      product.variant_image_match = this.normalizeVariantImageMatch(
        updateProductDto.variant_image_match,
      );
    }

    if (updateProductDto.variant_price_match !== undefined) {
      product.variant_price_match = this.normalizeVariantPriceMatch(
        updateProductDto.variant_price_match,
      );
    }

    if (!product.sku?.trim()) product.sku = this.buildProductSku(product.id);

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

    this.describePhotosLater(savedProduct.id);
    return this.findOwnedProduct(savedProduct.id, user.company_id);
  }

  async remove(id: number, user: AuthenticatedUser) {
    await this.assertProductBusiness(user.company_id);

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
      .split(/[;|\n]+|,\s*(?=https?:\/\/)/)
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

    const variantAvailableRaw = this.getRowValue(row, [/variant[_\s-]?available/]);
    if (variantAvailableRaw !== undefined && String(variantAvailableRaw).trim() !== '' && !this.normalizeBoolean(variantAvailableRaw)) {
      variant.available = false;
    }

    const variantWeight = this.normalizePrice(
      this.getRowValue(row, [/variant[_\s-]?weight/, /^variant weight$/]),
    );
    if (Number.isFinite(variantWeight) && variantWeight >= 0) {
      variant.weight = variantWeight;
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
        /^image_urls$/,
        /^images$/,
        /photo/,
      ]),
    );
    const coverImageUrl = String(
      this.getRowValue(row, [
        /cover_image_url/,
        /cover image/,
        /^cover_image$/,
        /^image_url$/,
        /main image/,
      ]) ?? '',
    ).trim();
    const sellingPoints = String(
      this.getRowValue(row, [/selling[_\s-]?points?/, /^usp$/]) ?? '',
    ).trim();
    const showToBotRaw = this.getRowValue(row, [/show[_\s-]?to[_\s-]?bot/]);
    const availableRaw = this.getRowValue(row, [/^available$/, /^is[_\s-]?available$/, /^availability$/]);
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
      ...(sellingPoints ? { sellingPoints } : {}),
      ...(showToBotRaw !== undefined && String(showToBotRaw).trim() !== '' ? { showToBot: this.normalizeBoolean(showToBotRaw) } : {}),
      ...(availableRaw !== undefined && String(availableRaw).trim() !== '' ? { available: this.normalizeBoolean(availableRaw) } : {}),
      ...(variant ? { variant } : {}),
      ...(legacyAttributeGroups.size ? { legacyAttributeGroups } : {}),
    };
  }

  private groupImportLines(lines: ImportLine[], warnings: string[] = []) {
    const errors: string[] = [];
    const groups = new Map<string, ImportProductGroup>();

    lines.forEach((line) => {
      if (!line.name) {
        warnings.push(`Row ${line.rowNumber}: skipped – no product name.`);
        return;
      }
      if (!line.categoryName) line.categoryName = 'General';
      const key = this.productImportKey(line.name, line.categoryName);
      const existing = groups.get(key);
      const isVariantContinuation = !!existing && !!line.variant;

      if (!existing) {
        groups.set(key, {
          rowNumbers: [line.rowNumber],
          name: line.name,
          description: line.description,
          sku: line.sku,
          price: Number.isFinite(line.price) ? line.price : 0,
          quantity: line.quantity,
          status: line.status,
          categoryName: line.categoryName,
          hasVariants: line.hasVariants,
          weight: line.weight,
          gallery: [...line.gallery],
          coverImageUrl: line.coverImageUrl,
          sellingPoints: line.sellingPoints,
          showToBot: line.showToBot,
          available: line.available,
          variants: [],
        });
      } else {
        existing.rowNumbers.push(line.rowNumber);
        if (line.description) existing.description = line.description;
        if (line.sku && !existing.sku) existing.sku = line.sku;
        if (Number.isFinite(line.price)) existing.price = line.price;
        if (line.quantity) existing.quantity = line.quantity;
        if (line.status) existing.status = line.status;
        if (line.hasVariants) existing.hasVariants = true;
        if (Number.isFinite(line.weight)) existing.weight = line.weight;
        if (line.gallery.length) {
          existing.gallery = Array.from(new Set([...existing.gallery, ...line.gallery]));
        }
        if (line.coverImageUrl) existing.coverImageUrl = line.coverImageUrl;
        if (line.sellingPoints) existing.sellingPoints = line.sellingPoints;
        if (line.showToBot !== undefined) existing.showToBot = line.showToBot;
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

      if (Number.isFinite(group.weight) && group.weight < 0) {
        errors.push(`Rows ${rowLabel}: weight cannot be below 0.`);
      }
      if (group.hasVariants && !group.variants.length) {
        group.hasVariants = false;
        warnings.push(`Rows ${rowLabel}: "has variants" was yes but no variant rows were found – imported without variants.`);
      }

      // a variant photo that is not in the gallery yet is simply added to it
      group.variants.forEach((variant) => {
        const imageUrl = variant.image_url?.trim();
        if (imageUrl && !gallery.includes(imageUrl)) gallery.push(imageUrl);
      });

      group.gallery = gallery;
      group.coverImageUrl = coverImage ?? '';
    });

    if (errors.length) {
      throw new BadRequestException(errors.join('; '));
    }

    return Array.from(groups.values());
  }

  private normalizeImportRows(rows: Record<string, unknown>[], warnings: string[] = []) {
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

    return this.groupImportLines(lines, warnings);
  }

  /** Same product code (SKU), or else the same name → that product is updated instead of added twice. */
  private async findImportMatch(group: ImportProductGroup, companyId: number): Promise<Product | null> {
    if (group.sku) {
      const bySku = await this.productRepository.createQueryBuilder('p')
        .where('p.company_id = :companyId AND p.is_deleted = false AND LOWER(p.sku) = LOWER(:sku)', { companyId, sku: group.sku }).getOne();
      if (bySku) return bySku;
    }
    return this.productRepository.createQueryBuilder('p')
      .where('p.company_id = :companyId AND p.is_deleted = false AND LOWER(TRIM(p.name)) = LOWER(TRIM(:name))', { companyId, name: group.name })
      .orderBy('p.id', 'DESC').getOne();
  }

  private async persistImportGroup(
    group: ImportProductGroup,
    user: AuthenticatedUser,
  ): Promise<{ product: Product; updated: boolean }> {
    const existing = await this.findImportMatch(group, Number(user.company_id));
    if (existing) {
      const dto: UpdateProductDto = {
        name: group.name,
        ...(group.description ? { description: group.description } : {}),
        ...(Number.isFinite(group.price) && group.price > 0 ? { price: group.price } : {}),
        ...(Number.isFinite(group.weight) ? { weight: group.weight } : {}),
        ...(group.gallery.length ? { gallery: group.gallery, image_url: group.coverImageUrl || group.gallery[0] } : {}),
        ...(group.sellingPoints !== undefined ? { selling_points: group.sellingPoints } : {}),
        ...(group.showToBot !== undefined ? { show_to_bot: group.showToBot } : {}),
        ...(group.available !== undefined ? { is_available: group.available } : {}),
        ...(group.sku ? { sku: group.sku } : {}),
        ...(group.hasVariants && group.variants.length ? { has_variants: true, variants: group.variants as never } : {}),
      };
      const category = await this.ensureCategoryByName(group.categoryName, user.company_id);
      dto.category_id = category.id;
      return { product: (await this.update(existing.id, dto, user)) as unknown as Product, updated: true };
    }
    const category = await this.ensureCategoryByName(
      group.categoryName,
      user.company_id,
    );

    const basePrice = Number.isFinite(group.price) ? group.price : 0;
    const normalizedVariants = this.normalizeVariants(
      group.variants,
      basePrice,
    );
    const hasVariants = group.hasVariants && normalizedVariants.length > 0;
    const gallery = this.normalizeGallery(group.gallery);
    const coverImage = this.resolveCoverImage(group.coverImageUrl, gallery);

    this.validateProductWeight(Number.isFinite(group.weight) ? group.weight : null);

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
        sku: group.sku && !(await this.productRepository.query(
          `SELECT 1 FROM product WHERE company_id = $1 AND LOWER(sku) = LOWER($2) AND is_deleted = FALSE`, [user.company_id, group.sku])).length ? group.sku : '',
        price: basePrice,
        quantity: productQuantity,
        status: group.status,
        category_id: category.id,
        company_id: user.company_id,
        created_by: user.id,
        has_variants: hasVariants,
        image_url: coverImage,
        gallery,
        weight: Number.isFinite(group.weight) ? Number(group.weight) : null,
        ...(group.sellingPoints !== undefined ? { selling_points: group.sellingPoints } : {}),
        ...(group.showToBot !== undefined ? { show_to_bot: group.showToBot } : {}),
        ...(group.available !== undefined ? { is_available: group.available } : {}),
        is_deleted: false,
        category,
      }),
    );

    await this.ensureProductSku(product);

    if (hasVariants) {
      await this.saveProductVariants(product, normalizedVariants, hasVariants);
    }

    return { product: (await this.findOwnedProduct(product.id, user.company_id)) as unknown as Product, updated: false };
  }

  /** Sample Excel file for the import: the columns, three filled examples (one with variants) and how to fill it. */
  importTemplate(): Buffer {
    const head = ['name', 'sku', 'category', 'price', 'description', 'weight', 'available', 'show_to_bot', 'selling_points', 'image_urls',
      'variant_name', 'variant_value', 'variant_price', 'variant_sku', 'variant_available', 'variant_weight', 'variant_image_url'];
    const rows = [
      ['Cotton Romper Set (3 pcs)', 'ROMP-001', 'Baby clothes', 2450, 'Soft cotton rompers for 0-12 months', 0.3, 'yes', 'yes', 'Soft, breathable, easy snaps',
        'https://example.com/romper-1.jpg, https://example.com/romper-2.jpg', '', '', '', '', '', '', ''],
      ['Baby Shoes', 'SHOE-01', 'Shoes', 1800, 'Non-slip soft sole', '', 'yes', 'yes', '', 'https://example.com/shoes.jpg',
        'Size', '0-6 months', 1800, 'SHOE-01-S', 'yes', '', ''],
      ['Baby Shoes', 'SHOE-01', 'Shoes', 1800, '', '', '', '', '', '', 'Size', '6-12 months', 1950, 'SHOE-01-M', 'yes', '', ''],
      ['Gift Pack', '', 'Gifts', 5500, 'Diapers, wipes and a towel in a gift box', 2.5, 'no', 'yes', 'Perfect for baby showers', '', '', '', '', '', '', '', ''],
    ];
    const help = [
      ['Column', 'What to write'],
      ['name', 'Product name (required). Several rows with the same name = one product with variants.'],
      ['sku', 'Your product code (optional). If a product with this code – or this name – already exists it is UPDATED, not added again.'],
      ['category', 'Category name (optional – "General" when empty). New categories are created.'],
      ['price', 'Price in Rs (numbers only).'],
      ['description', 'Short description (optional).'],
      ['weight', 'Weight in kg (optional – only needed when the delivery fee is charged by weight).'],
      ['available', 'yes / no (optional, default yes).'],
      ['show_to_bot', 'yes / no – no = the AI bot never offers it (default yes).'],
      ['selling_points', 'Why customers love it – the AI bot uses this (optional).'],
      ['image_urls', 'Full photo links (https://…), separated by commas. The first one is the cover.'],
      ['variant_name / variant_value', 'For variants: one row per option, e.g. Size / 0-6 months. Leave empty for simple products.'],
      ['variant_price, variant_sku, variant_available, variant_weight, variant_image_url', 'Optional details of that option.'],
    ];
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([head, ...rows]);
    sheet['!cols'] = head.map((h) => ({ wch: Math.max(12, h.length + 2) }));
    XLSX.utils.book_append_sheet(book, sheet, 'Products');
    const guide = XLSX.utils.aoa_to_sheet(help);
    guide['!cols'] = [{ wch: 34 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(book, guide, 'How to fill');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  async import(file: { buffer: Buffer } | undefined, user: AuthenticatedUser) {
    await this.assertProductBusiness(user.company_id);

    if (!file) {
      throw new BadRequestException('A CSV or Excel file is required');
    }

    const rawRows = this.readImportRows(file);
    const warnings: string[] = [];
    const groupedRows = this.normalizeImportRows(rawRows, warnings);
    if (!groupedRows.length) throw new BadRequestException(warnings.length ? warnings.join(' ') : 'No products found in the file. Download the sample file and fill it in.');
    const createdProducts: Product[] = [];
    let updated = 0;
    // package limit: only products that do not exist yet count
    const existingNames = new Set(
      (await this.productRepository.find({ where: { company_id: user.company_id, is_deleted: false } as never, select: ['name'] as never }))
        .map((p) => String(p.name).trim().toLowerCase()),
    );
    await this.assertProductRoom(Number(user.company_id), groupedRows.filter((g) => !existingNames.has(String(g.name ?? '').trim().toLowerCase())).length);

    for (const group of groupedRows) {
      try {
        const result = await this.persistImportGroup(group, user);
        createdProducts.push(result.product);
        if (result.updated) updated++;
      } catch (error) {
        warnings.push(`Rows ${group.rowNumbers.join(', ')} (${group.name}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      imported_count: createdProducts.length,
      created_count: createdProducts.length - updated,
      updated_count: updated,
      warnings,
      items: createdProducts,
    };
  }

  /** One tap from the list / app: the whole product, or one variant option (by its value, e.g. "Red / M"). */
  async setAvailability(id: number, available: boolean, variantValue: string | undefined, user: AuthenticatedUser) {
    const product = await this.productRepository.findOne({ where: { id, company_id: user.company_id, is_deleted: false } as never, relations: ['variants'] });
    if (!product) throw new NotFoundException('Product not found');
    if (!variantValue) {
      product.is_available = available;
      await this.productRepository.save(product);
      return { id: product.id, is_available: product.is_available };
    }
    const row = (product as unknown as { variants?: Array<{ id: number; variants: Array<Record<string, unknown>> }> }).variants?.[0];
    const wanted = variantValue.trim().toLowerCase();
    const option = row?.variants?.find((v) => String(v.variant_value ?? '').trim().toLowerCase() === wanted);
    if (!row || !option) throw new NotFoundException('Variant not found');
    if (available) delete option.available;
    else option.available = false;
    await this.productVariantRepository.update(row.id, { variants: row.variants } as never);
    return { id: product.id, variant_value: option.variant_value, available };
  }
}
