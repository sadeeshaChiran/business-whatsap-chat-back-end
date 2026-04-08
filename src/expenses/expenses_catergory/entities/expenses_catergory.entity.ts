import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Expense } from '../../entities/expense.entity';

@Entity()
export class ExpensesCatergory {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column()
  company_id!: number;

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
