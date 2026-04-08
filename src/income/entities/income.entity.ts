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

@Entity()
export class Income {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  company_id: number;

  @Column({ type: 'datetime' })
  date: Date;

  @Column({ type: 'int' })
  amount: number;

  @Column({ type: 'varchar', length: 255 })
  note: string;

  @Column({ type: 'enum', enum: SourseType, default: SourseType.manual })
  sourse: SourseType;

  @Column()
  created_user_id: number;

  @ManyToOne(() => IncomeCatergory, (category) => category.income, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'income_category_id' })
  incomeCategory: IncomeCatergory;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
