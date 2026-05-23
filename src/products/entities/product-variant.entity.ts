import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PRODUCT_DATA_SOURCE } from '../product-database';
import { Product } from './product.entity';

@Entity(PRODUCT_DATA_SOURCE ? { database: 'supabase' } : {})
export class ProductVariant {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  product_id: number;

  @Column({ type: 'varchar', length: 100 })
  variant_name: string;

  @Column({ type: 'varchar', length: 100 })
  variant_value: string;

  @ManyToOne(() => Product, (product) => product.variants, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;
}
