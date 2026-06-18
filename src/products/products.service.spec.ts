import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { ProductsService } from './products.service';
import { Product } from './entities/product.entity';
import { ProductVariant } from './entities/product-variant.entity';
import { ProductCatergory } from './product_catergory/entities/product_catergory.entity';

describe('ProductsService', () => {
  let service: ProductsService;

  const productRepository = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => ({ ...value, id: 101 })),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const productVariantRepository = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    delete: jest.fn(),
  };

  const productCategoryRepository = {
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => ({ ...value, id: 7 })),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        {
          provide: getRepositoryToken(Product),
          useValue: productRepository,
        },
        {
          provide: getRepositoryToken(ProductVariant),
          useValue: productVariantRepository,
        },
        {
          provide: getRepositoryToken(ProductCatergory),
          useValue: productCategoryRepository,
        },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('import row grouping', () => {
    const normalizeImportRows = (rows: Record<string, unknown>[]) =>
      (service as unknown as { normalizeImportRows: typeof rows extends never ? never : (rows: Record<string, unknown>[]) => unknown }).normalizeImportRows(rows);

    it('groups variant rows into one product', () => {
      const groups = normalizeImportRows([
        {
          name: 'Baby Onesie',
          description: 'Soft cotton onesie',
          category: 'Clothing',
          weight: '0.12',
          base_price: '1800',
          has_variants: 'yes',
          gallery_urls: 'https://example.com/a.jpg;https://example.com/b.jpg',
          cover_image_url: 'https://example.com/a.jpg',
          variant_name: 'Color / Size',
          variant_value: 'Red / M',
          variant_price: '1800',
          variant_quantity: '8',
          variant_sku: 'RED-M-01',
          variant_image_url: 'https://example.com/a.jpg',
        },
        {
          name: 'Baby Onesie',
          category: 'Clothing',
          variant_name: 'Color / Size',
          variant_value: 'Black / L',
          variant_price: '1850',
          variant_quantity: '3',
          variant_sku: 'BLK-L-01',
          variant_image_url: 'https://example.com/b.jpg',
        },
      ]) as Array<{
        name: string;
        variants: Array<{ variant_value: string; quantity?: number; sku?: string }>;
        gallery: string[];
        weight: number;
      }>;

      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Baby Onesie');
      expect(groups[0].variants).toHaveLength(2);
      expect(groups[0].variants[0].variant_value).toBe('Red / M');
      expect(groups[0].variants[1].sku).toBe('BLK-L-01');
      expect(groups[0].gallery).toEqual([
        'https://example.com/a.jpg',
        'https://example.com/b.jpg',
      ]);
      expect(groups[0].weight).toBe(0.12);
    });

    it('builds legacy attribute combinations on a single row', () => {
      const groups = normalizeImportRows([
        {
          name: 'Legacy Shirt',
          category: 'Clothing',
          weight: '0.2',
          price: '1500',
          has_variants: 'yes',
          gallery_urls: 'https://example.com/shirt.jpg',
          cover_image_url: 'https://example.com/shirt.jpg',
          variant_name_1: 'Size',
          variant_value_1: 'M',
          variant_name_2: 'Size',
          variant_value_2: 'L',
          variant_name_3: 'Color',
          variant_value_3: 'Red',
        },
      ]) as Array<{ variants: Array<{ variant_value: string }> }>;

      expect(groups).toHaveLength(1);
      expect(groups[0].variants).toHaveLength(2);
      expect(groups[0].variants.map((variant) => variant.variant_value).sort()).toEqual([
        'L / Red',
        'M / Red',
      ]);
    });

    it('requires weight but allows missing price and images', () => {
      expect(() =>
        normalizeImportRows([
          {
            name: 'No Media Product',
            category: 'Care',
          },
        ]),
      ).toThrow(BadRequestException);

      const groups = normalizeImportRows([
        {
          name: 'No Media Product',
          category: 'Care',
          weight: '0.1',
        },
      ]);

      expect(groups).toHaveLength(1);
      expect(groups[0].price).toBe(0);
      expect(groups[0].gallery).toEqual([]);
    });

    it('rejects variant image outside gallery', () => {
      expect(() =>
        normalizeImportRows([
          {
            name: 'Bad Image Product',
            category: 'Care',
            weight: '0.1',
            price: '100',
            gallery_urls: 'https://example.com/a.jpg',
            cover_image_url: 'https://example.com/a.jpg',
            has_variants: 'yes',
            variant_name: 'Color',
            variant_value: 'Red',
            variant_image_url: 'https://example.com/other.jpg',
          },
        ]),
      ).toThrow(BadRequestException);
    });
  });

  describe('import sample csv', () => {
    it('parses the bundled sample import file', () => {
      const samplePath = path.resolve(
        __dirname,
        '../../scripts/sample_product_import.csv',
      );
      const csv = fs.readFileSync(samplePath, 'utf8');
      const rows = csv
        .trim()
        .split('\n')
        .slice(1)
        .filter(Boolean)
        .map((line) => {
          const cells: string[] = [];
          let current = '';
          let inQuotes = false;

          for (const char of line) {
            if (char === '"') {
              inQuotes = !inQuotes;
              continue;
            }
            if (char === ',' && !inQuotes) {
              cells.push(current);
              current = '';
              continue;
            }
            current += char;
          }
          cells.push(current);

          const headers = [
            'name',
            'description',
            'category',
            'weight',
            'base_price',
            'quantity',
            'status',
            'has_variants',
            'gallery_urls',
            'cover_image_url',
            'sku',
            'variant_name',
            'variant_value',
            'variant_price',
            'variant_quantity',
            'variant_sku',
            'variant_image_url',
          ];

          return Object.fromEntries(
            headers.map((header, index) => [header, cells[index] ?? '']),
          );
        });

      const normalizeImportRows = (input: Record<string, unknown>[]) =>
        (service as unknown as {
          normalizeImportRows: (rows: Record<string, unknown>[]) => unknown;
        }).normalizeImportRows(input);

      const groups = normalizeImportRows(rows) as Array<{
        name: string;
        variants: unknown[];
      }>;

      expect(groups).toHaveLength(2);
      expect(groups.find((group) => group.name === 'Baby Wipes Pack')).toBeDefined();
      expect(
        groups.find((group) => group.name === 'Baby Onesie')?.variants,
      ).toHaveLength(4);
    });
  });

  describe('variant price match', () => {
    it('normalizes dimension price map', () => {
      const normalizeVariantPriceMatch = (
        match: {
          dimensions?: string[];
          prices?: Record<string, number>;
        } | null,
      ) =>
        (
          service as unknown as {
            normalizeVariantPriceMatch: (
              match: {
                dimensions?: string[];
                prices?: Record<string, number>;
              } | null,
            ) => { dimensions: string[]; prices: Record<string, number> } | null;
          }
        ).normalizeVariantPriceMatch(match);

      expect(
        normalizeVariantPriceMatch({
          dimensions: [' Size ', 'Color'],
          prices: { '12-24 Months': 1850, '': 100, Bad: Number.NaN },
        }),
      ).toEqual({
        dimensions: ['Size', 'Color'],
        prices: { '12-24 Months': 1850 },
      });
    });
  });

  describe('product sku', () => {
    it('builds SKU from product id', () => {
      const buildProductSku = (productId: number) =>
        (service as unknown as { buildProductSku: (productId: number) => string }).buildProductSku(
          productId,
        );

      expect(buildProductSku(42)).toBe('SKU-42');
    });
  });

  describe('variant defaults', () => {
    it('applies base price when variant price is missing', () => {
      const normalizeVariants = (
        variants: Array<{ variant_name: string; variant_value: string; price?: number }>,
        basePrice: number,
      ) =>
        (service as unknown as {
          normalizeVariants: (
            variants: Array<{ variant_name: string; variant_value: string; price?: number }>,
            basePrice: number,
          ) => Array<{ price: number }>;
        }).normalizeVariants(variants, basePrice);

      const normalized = normalizeVariants(
        [{ variant_name: 'Color', variant_value: 'Red' }],
        1500,
      );

      expect(normalized[0].price).toBe(1500);
    });
  });
});
