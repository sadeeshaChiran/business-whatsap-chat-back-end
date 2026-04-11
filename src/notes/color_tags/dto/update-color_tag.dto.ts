import { PartialType } from '@nestjs/swagger';
import { CreateColorTagDto } from './create-color_tag.dto';

export class UpdateColorTagDto extends PartialType(CreateColorTagDto) {}
