import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

export class CreateNoteDto {
  @ApiProperty({ example: 'Follow up with supplier', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  title: string;

  @ApiProperty({
    example: 'Call supplier on Monday to discuss revised payment terms.',
  })
  @IsString()
  content: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  color_tag_id: number;

  @ApiProperty({ example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  company_id: number;
}
