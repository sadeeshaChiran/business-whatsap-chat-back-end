import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).+$/;
export const PASSWORD_MESSAGE = 'Password must have at least 8 characters with letters and numbers.';

export class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(255) current_password: string;
  @IsString() @MinLength(8, { message: PASSWORD_MESSAGE }) @MaxLength(128) @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  new_password: string;
}

export class ForgotPasswordDto {
  @IsEmail() @MaxLength(255) email: string;
}

export class ResetPasswordDto {
  @IsEmail() @MaxLength(255) email: string;
  @IsString() @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from the email.' }) code: string;
  @IsString() @MinLength(8, { message: PASSWORD_MESSAGE }) @MaxLength(128) @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  new_password: string;
}
