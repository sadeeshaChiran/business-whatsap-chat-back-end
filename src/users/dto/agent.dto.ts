import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MESSAGE, PASSWORD_RULE } from '../../auth/dto/password.dto';

export class CreateAgentDto {
  @IsString() @MinLength(2, { message: 'Enter the agent name (at least 2 characters).' }) @MaxLength(120)
  name: string;

  @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(255)
  email: string;

  @IsString() @MinLength(8, { message: PASSWORD_MESSAGE }) @MaxLength(128) @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password: string;

  /** agent (default) or supervisor (team lead) */
  @IsOptional() @IsIn(['agent', 'supervisor'], { message: 'Choose Agent or Supervisor.' })
  team_role?: 'agent' | 'supervisor';
}

export class UpdateAgentDto {
  @IsOptional() @IsString() @MinLength(2, { message: 'Enter the agent name (at least 2 characters).' }) @MaxLength(120)
  name?: string;

  @IsOptional() @IsIn(['agent', 'supervisor'], { message: 'Choose Agent or Supervisor.' })
  team_role?: 'agent' | 'supervisor';
}

export class ResetAgentPasswordDto {
  @IsString() @MinLength(8, { message: PASSWORD_MESSAGE }) @MaxLength(128) @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password: string;
}
