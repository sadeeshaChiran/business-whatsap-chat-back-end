import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  @MaxLength(50)
  customer_phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  assigned_instance?: string;
}
