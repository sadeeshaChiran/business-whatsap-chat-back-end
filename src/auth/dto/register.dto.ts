import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Matches,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

class RegisterCompanyDto {
  @ApiProperty({ example: 'Acme Pvt Ltd', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ enum: ['product', 'service'], default: 'product' })
  @IsOptional()
  @IsString()
  @IsIn(['product', 'service'])
  category?: 'product' | 'service';
}

export class RegisterDto {
  @ApiProperty({ example: 'Jane Doe', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'jane@company.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ example: 'StrongPass123', minLength: 6 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: 'Password must have at least 8 characters with letters and numbers.' })
  password: string;

  @ApiProperty({ type: () => RegisterCompanyDto })
  @ValidateNested()
  @Type(() => RegisterCompanyDto)
  company: RegisterCompanyDto;
}
