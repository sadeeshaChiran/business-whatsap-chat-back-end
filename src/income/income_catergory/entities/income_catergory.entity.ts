import {
  Entity,
  JoinColumn,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
  ManyToOne,
} from 'typeorm';
import { Income } from '../../entities/income.entity';
import { Company } from '../../../company/entities/company.entity';

@Entity()
@Unique('UQ_income_category_company_name', ['company_id', 'name'])
export class IncomeCatergory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column()
  company_id: number;

  @Column({ type: 'boolean', default: false })
  is_common: boolean;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @OneToMany(() => Income, (income) => income.incomeCategory)
  income: Income[];

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;

  @ManyToOne(() => Company, (company) => company.incomeCategories, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'company_id' })
  company: Company;
}
