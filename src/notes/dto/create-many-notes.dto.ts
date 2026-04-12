import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateNoteDto } from './create-note.dto';

export class CreateManyNotesDto {
  @ApiProperty({ type: [CreateNoteDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateNoteDto)
  items!: CreateNoteDto[];
}