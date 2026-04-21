import { ApiProperty } from '@nestjs/swagger';

export class ImportProductsFileDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'CSV or Excel file containing product rows to import',
  })
  file: unknown;
}
