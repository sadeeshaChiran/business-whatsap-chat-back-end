import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from '../../../company/entities/company.entity';
import { Product } from '../../entities/product.entity';
import { ProductCategoryVariant } from './product_category_variant.entity';

@Entity()
@Unique('UQ_product_category_company_name', ['company_id', 'name'])
export class ProductCatergory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column()
  company_id: number | null;

  @Column({ type: 'boolean', default: false })
  is_common: boolean;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @ManyToOne(() => Company, {
    nullable: true,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'company_id' })
  company: Company | null;

  @OneToMany(() => Product, (product) => product.category)
  products: Product[];

  @OneToMany(
    () => ProductCategoryVariant,
    (defaultVariant) => defaultVariant.category,
    { cascade: true },
  )
  default_variants: ProductCategoryVariant[];

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
