import { IsIn, IsString } from 'class-validator';

export const LEAD_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export class UpdateLeadStageDto {
  @IsString()
  @IsIn(LEAD_STAGES)
  lead_stage: LeadStage;
}
