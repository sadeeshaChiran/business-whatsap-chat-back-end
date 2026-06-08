import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Product } from './product.entity';

export type ProductVariantOption = {
  variant_name: string;
  variant_value: string;
  price?: number;
  secondary_price_1?: number;
  secondary_price_2?: number;
  quantity?: number;
  sku?: string;
  image_url?: string;
};

@Entity()
export class ProductVariant {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  product_id: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  variants: ProductVariantOption[];

  @ManyToOne(() => Product, (product) => product.variants, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;
}
