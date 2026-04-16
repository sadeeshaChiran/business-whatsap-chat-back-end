import { IsIn, IsOptional } from 'class-validator';

export type ReportPeriod = 'weekly' | 'monthly';

export class ReportQueryDto {
  @IsOptional()
  @IsIn(['weekly', 'monthly'])
  period?: ReportPeriod;
}
