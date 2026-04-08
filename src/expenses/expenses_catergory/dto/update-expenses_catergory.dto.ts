import { PartialType } from '@nestjs/swagger';
import { CreateExpensesCatergoryDto } from './create-expenses_catergory.dto';

export class UpdateExpensesCatergoryDto extends PartialType(
  CreateExpensesCatergoryDto,
) {}
