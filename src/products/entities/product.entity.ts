import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ProductCatergory } from '../product_catergory/entities/product_catergory.entity';
import { ProductVariant } from './product-variant.entity';

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'varchar', length: 100, default: '' })
  sku: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ type: 'int', default: 0 })
  quantity: number;

  @Column({ type: 'varchar', length: 50, default: 'In Stock' })
  status: string;

  @Column({ type: 'int' })
  category_id: number;

  @Column({ type: 'int' })
  company_id: number;

  @Column({ type: 'int' })
  created_by: number;

  @Column({ type: 'boolean', default: false })
  has_variants: boolean;

  @Column({ type: 'text', nullable: true })
  image_url: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  gallery: string[];

  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  weight: number | null;

  @Column({ type: 'jsonb', nullable: true })
  variant_image_match: {
    dimensions: string[];
    images: Record<string, string>;
  } | null;

  @Column({ type: 'boolean', default: false })
  is_deleted: boolean;

  @Column({
    type: 'bytea',
    nullable: true,
    select: false,
  })
  vector_embedding: Buffer | null;

  @ManyToOne(() => ProductCatergory, (category) => category.products, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'category_id' })
  category: ProductCatergory;

  @OneToMany(() => ProductVariant, (variant) => variant.product, {
    cascade: true,
  })
  variants: ProductVariant[];

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
