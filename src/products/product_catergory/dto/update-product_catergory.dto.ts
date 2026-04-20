import { PartialType } from '@nestjs/swagger';
import { CreateProductCatergoryDto } from './create-product_catergory.dto';

export class UpdateProductCatergoryDto extends PartialType(
  CreateProductCatergoryDto,
) {}
