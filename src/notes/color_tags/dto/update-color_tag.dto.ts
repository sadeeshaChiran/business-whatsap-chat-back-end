import { PartialType } from '@nestjs/swagger';
import { CreateNoteColorTagsDto } from './create-color_tag.dto';

export class UpdateNoteColorTagsDto extends PartialType(CreateNoteColorTagsDto) {}
