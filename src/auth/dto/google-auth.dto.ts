import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class GoogleAuthCompanyDto {
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

export class GoogleAuthDto {
  @ApiProperty({ description: 'Google Identity Services ID token' })
  @IsString()
  credential: string;

  @ApiPropertyOptional({ enum: ['login', 'register'], default: 'login' })
  @IsOptional()
  @IsString()
  @IsIn(['login', 'register'])
  mode?: 'login' | 'register';

  @ApiPropertyOptional({ type: () => GoogleAuthCompanyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GoogleAuthCompanyDto)
  company?: GoogleAuthCompanyDto;
}
