import { IsDateString, IsIn, IsOptional } from 'class-validator';

export type ReportPeriod = 'weekly' | 'monthly';

export class ReportQueryDto {
  @IsOptional()
  @IsIn(['weekly', 'monthly'])
  period?: ReportPeriod;

  @IsOptional()
  @IsDateString()
  start_date?: string;

  @IsOptional()
  @IsDateString()
  end_date?: string;
}
