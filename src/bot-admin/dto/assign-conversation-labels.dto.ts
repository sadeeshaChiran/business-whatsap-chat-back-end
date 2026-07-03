import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsInt, Min } from 'class-validator';

export class AssignConversationLabelsDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayUnique()
  @Transform(({ value }) => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
  })
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  label_ids: number[];
}
