import { IsString, MinLength } from 'class-validator';

export class ConnectMetaPageDto {
  @IsString()
  @MinLength(1)
  page_id: string;
}
