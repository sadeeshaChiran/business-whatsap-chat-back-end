import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateNoteColorTagsDto } from './create-color_tag.dto';

export class CreateManyNoteColorTagsDto {
  @ApiProperty({ type: [CreateNoteColorTagsDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateNoteColorTagsDto)
  items!: CreateNoteColorTagsDto[];
}