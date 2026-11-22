import { ArrayMaxSize, IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateBotTrainingDto {
  @IsString()
  @IsNotEmpty()
  question: string;

  @IsString()
  @IsNotEmpty()
  answer: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  language?: string;

  /** files uploaded with POST /bot/train/files (photo / MP4 / PDF), at most 5 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  files?: Array<{ url: string; name?: string; size?: number }>;
}
