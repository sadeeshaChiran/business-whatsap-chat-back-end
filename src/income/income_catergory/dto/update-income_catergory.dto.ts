import { PartialType } from '@nestjs/swagger';
import { CreateIncomeCatergoryDto } from './create-income_catergory.dto';

export class UpdateIncomeCatergoryDto extends PartialType(
  CreateIncomeCatergoryDto,
) {}
