import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SourseType } from '../../expenses/entities/expense.entity';
import { IncomeCatergory } from '../income_catergory/entities/income_catergory.entity';
import { Company } from '../../company/entities/company.entity';

@Entity()
export class Income {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  company_id: number;

  @Column({ type: 'timestamp' })
  date: Date;

  @Column({ type: 'int' })
  amount: number;

  @Column({ type: 'varchar', length: 255 })
  note: string;

  @Column({ type: 'varchar', length: 20, default: SourseType.manual })
  sourse: SourseType;

  @Column({ type: 'int' })
  created_user_id: number;

  @ManyToOne(() => IncomeCatergory, (category) => category.income, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'income_category_id' })
  incomeCategory: IncomeCatergory;

  @ManyToOne(() => Company, (company) => company.incomes, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
