import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { IncomeCatergory } from '../../income/income_catergory/entities/income_catergory.entity';
import { Income } from '../../income/entities/income.entity';
import { NoteColorTags } from '../../notes/color_tags/entities/color_tag.entity';
import { Note } from '../../notes/entities/note.entity';

@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ name: 'company_name', type: 'text' })
  name: string;

  @Column({ type: 'text', default: 'ACTIVE' })
  status: string;

  @Column({ type: 'text', default: '' })
  plan: string;

  @Column({ type: 'text', default: '' })
  email: string;

  @Column({ type: 'text', default: '' })
  phone: string;

  @Column({ type: 'text', default: '' })
  address: string;

  @Column({ type: 'bigint', nullable: true })
  admin_user_id: number | null;

  @Column({ type: 'bigint', nullable: true })
  industry_id: number | null;

  @Column({ type: 'boolean', default: true })
  is_email_nofications: boolean;

  @Column({ type: 'boolean', default: true })
  is_weekly_report: boolean;

  @Column({ type: 'boolean', default: true })
  is_monthly_report: boolean;

  @OneToMany(() => IncomeCatergory, (incomeCategory) => incomeCategory.company)
  incomeCategories: IncomeCatergory[];

  @OneToMany(() => Income, (income) => income.company)
  incomes: Income[];

  @OneToMany(() => NoteColorTags, (colorTag) => colorTag.company)
  colorTags: NoteColorTags[];

  @OneToMany(() => Note, (note) => note.company)
  notes: Note[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
