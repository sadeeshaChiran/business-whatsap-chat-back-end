import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Expense } from '../../entities/expense.entity';

@Entity()
@Unique('UQ_expense_category_company_name', ['company_id', 'name'])
export class ExpensesCatergory {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'int', nullable: true })
  company_id!: number | null;

  @Column({ type: 'boolean', default: false })
  is_common!: boolean;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @OneToMany(() => Expense, (expense) => expense.expenseCategory)
  expenses!: Expense[];

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at!: Date;
}
