import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ExpensesCatergory } from '../expenses_catergory/entities/expenses_catergory.entity';

export enum SourseType {
  manual = 'manual',
  api = 'api',
  excel = 'excel',
}

@Entity()
export class Expense {
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

  @ManyToOne(() => ExpensesCatergory, (category) => category.expenses, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'expense_category_id' })
  expenseCategory: ExpensesCatergory;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
