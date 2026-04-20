import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ProductCatergory } from './product_catergory.entity';

@Entity()
export class ProductCategoryVariant {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  category_id: number;

  @Column({ type: 'varchar', length: 100 })
  variant_name: string;

  @ManyToOne(() => ProductCatergory, (category) => category.default_variants, {
    nullable: false,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'category_id' })
  category: ProductCatergory;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;
}
