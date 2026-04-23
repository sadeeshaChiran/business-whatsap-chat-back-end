import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
