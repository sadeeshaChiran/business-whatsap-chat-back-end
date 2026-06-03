import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateEvolutionInstanceDto {
  @ApiProperty({ example: 'my-shop-whatsapp' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  whatsapp_instance_name: string;
}
