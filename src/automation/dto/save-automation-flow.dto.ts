import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class SaveAutomationFlowDto {
  @IsString() @IsNotEmpty() @MaxLength(255) name: string;
  @IsOptional() @IsString() description?: string;
  @IsString() @IsNotEmpty() @MaxLength(50) trigger_type: string;
  @IsString() @IsIn(['draft', 'active', 'paused']) status: 'draft' | 'active' | 'paused';
  @IsObject() definition: { nodes: unknown[]; edges: unknown[] };
}
