import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Industry } from '../industry/entities/industry.entity';

import { IncomeCatergory } from '../../income/income_catergory/entities/income_catergory.entity';
import { Income } from '../../income/entities/income.entity';
import { User } from '../../users/entities/user.entity';

@Entity()
export class Company {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', default: '' })
  plan: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  email: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  phone: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  address: string;

  @Column({ type: 'boolean', default: true })
  is_email_nofications: boolean;

  @Column({ type: 'boolean', default: true })
  is_weekly_report: boolean;

  @Column({ type: 'boolean', default: true })
  is_monthly_report: boolean;

  @ManyToOne(() => Industry, (industry) => industry.companies, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'industry_id' })
  industry: Industry;

  @OneToMany(() => IncomeCatergory, (incomeCategory) => incomeCategory.company)
  incomeCategories: IncomeCatergory[];

  @OneToMany(() => Income, (income) => income.company)
  incomes: Income[];

  @OneToMany(() => User, (user) => user.company)
  users: User[];
}
