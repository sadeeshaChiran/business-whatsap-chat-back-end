import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
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
  @MinLength(6)
  @MaxLength(255)
  password: string;

  @ApiProperty({ type: () => RegisterCompanyDto })
  @ValidateNested()
  @Type(() => RegisterCompanyDto)
  company: RegisterCompanyDto;
}
