import { BrandingService } from '../platform/branding.service';
import {
  BadRequestException, Body, ConflictException, Controller, HttpCode, HttpException, HttpStatus, Injectable, Module, NotFoundException, Post,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RegisterDto } from '../auth/dto/register.dto';
import { ForgotPasswordDto, ResetPasswordDto } from '../auth/dto/password.dto';
import { Throttle } from '@nestjs/throttler';
import { codeEmail, otpDevMode, sendEmail, sendPhoneCode } from './senders';

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 6;
const REGISTRATION_TTL_MIN = 30;

/** Sri Lankan numbers: 0771234567 / 771234567 / +94771234567 → 94771234567. Other countries: digits with country code. */
export function normalizeWhatsapp(value: string): string {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith('0')) digits = `94${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith('7')) digits = `94${digits}`;
  return digits;
}

/* ───────── DTOs ───────── */

class RegisterCompanyInput {
  @IsString() @MinLength(2) @MaxLength(255) name: string;
  @IsOptional() @IsIn(['product', 'service', 'both']) category?: 'product' | 'service' | 'both';
}

export class RegisterStartDto {
  @IsString() @MinLength(2) @MaxLength(255) name: string;
  @IsEmail() @MaxLength(255) email: string;
  @IsString() @MinLength(8) @MaxLength(255)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: 'Password must have at least 8 characters with letters and numbers.' })
  password: string;
  /** the admin's WhatsApp number – a code is sent to it */
  @IsString() @MinLength(9) @MaxLength(20) whatsapp: string;
  @ValidateNested() @Type(() => RegisterCompanyInput) company: RegisterCompanyInput;
}

export class RegisterVerifyDto {
  @IsString() @Length(10, 40) registration_id: string;
  @IsString() @Matches(/^\d{6}$/) email_code: string;
  @IsString() @Matches(/^\d{6}$/) whatsapp_code: string;
}

export class RegisterResendDto {
  @IsString() @Length(10, 40) registration_id: string;
  @IsIn(['email', 'whatsapp']) channel: 'email' | 'whatsapp';
}

export class ChangeEmailStartDto {
  @IsEmail() @MaxLength(255) new_email: string;
  @IsString() @MinLength(1) password: string;
}

export class ChangeWhatsappStartDto {
  @IsString() @MinLength(9) @MaxLength(20) whatsapp: string;
}

export class CodeDto {
  @IsString() @Matches(/^\d{6}$/) code: string;
}

/* ───────── Service ───────── */

@Injectable()
export class VerificationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly authService: AuthService,
  ) {}

  private secret() {
    const secret = String(process.env.OTP_SECRET || process.env.JWT_SECRET || '').trim();
    if (!secret) throw new Error('JWT_SECRET is required');
    return secret;
  }

  private hash(code: string, reference: string) {
    return createHmac('sha256', this.secret()).update(`${reference}:${code}`).digest('hex');
  }

  private encrypt(text: string) {
    const key = createHash('sha256').update(this.secret()).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
  }

  private decrypt(payload: string) {
    const [iv, tag, data] = payload.split('.').map((part) => Buffer.from(part, 'base64'));
    const key = createHash('sha256').update(this.secret()).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  /** Creates and sends a code. Limits: one per minute and a few per hour for the same target. */
  private async issue(purpose: string, reference: string, target: string, channel: 'email' | 'whatsapp', intro: string) {
    const [recent] = await this.dataSource.query(
      `SELECT MAX(created_at) AS last, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS hour
         FROM verification_code WHERE target = $1 AND purpose = $2`, [target, purpose]);
    if (recent?.last && Date.now() - new Date(recent.last).getTime() < RESEND_SECONDS * 1000) {
      throw new HttpException(`Please wait ${RESEND_SECONDS} seconds before asking for a new code.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (Number(recent?.hour ?? 0) >= MAX_SENDS_PER_HOUR) {
      throw new HttpException('Too many codes were sent. Please try again in an hour.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    let sentVia: string | null = null;
    if (channel === 'email') {
      const { text, html } = codeEmail(code, intro);
      sentVia = (await sendEmail(target, `${code} is your ${BrandingService.current().name} code`, text, html)) ? 'email' : null;
    } else {
      sentVia = await sendPhoneCode(target, code);
    }
    if (!sentVia) {
      throw new BadRequestException(channel === 'email'
        ? 'We could not send the email. Check the address and try again.'
        : 'We could not send the WhatsApp code. Check the number (with country code) and try again.');
    }
    await this.dataSource.query(
      `INSERT INTO verification_code (purpose, reference, target, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5::int))`,
      [purpose, reference, target, this.hash(code, reference), CODE_TTL_MIN]);
    return { sent_via: sentVia, ...(otpDevMode() ? { dev_code: code } : {}) };
  }

  /** Checks the newest code for this reference + purpose (attempt limit, expiry, one use). */
  private async check(purpose: string, reference: string, code: string): Promise<string> {
    const [row] = await this.dataSource.query(
      `SELECT * FROM verification_code WHERE reference = $1 AND purpose = $2 ORDER BY id DESC LIMIT 1`, [reference, purpose]);
    const label = purpose.includes('email') ? 'email' : 'WhatsApp';
    if (!row || row.verified_at) throw new BadRequestException(`Ask for a new ${label} code.`);
    if (new Date(row.expires_at) < new Date()) throw new BadRequestException(`The ${label} code has expired. Ask for a new one.`);
    if (row.attempts >= MAX_ATTEMPTS) throw new BadRequestException(`Too many wrong ${label} codes. Ask for a new one.`);
    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(this.hash(code, reference), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      await this.dataSource.query(`UPDATE verification_code SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      throw new BadRequestException(`The ${label} code is not correct.`);
    }
    await this.dataSource.query(`UPDATE verification_code SET verified_at = NOW() WHERE id = $1`, [row.id]);
    return row.target;
  }

  /* ───── Sign-up ───── */

  async registerStart(dto: RegisterStartDto) {
    const email = dto.email.trim().toLowerCase();
    const whatsapp = normalizeWhatsapp(dto.whatsapp);
    if (whatsapp.length < 10 || whatsapp.length > 15) throw new BadRequestException('Enter your WhatsApp number with the country code, e.g. 94771234567.');
    const [taken] = await this.dataSource.query(`SELECT 1 FROM app_user WHERE LOWER(email) = $1`, [email]);
    if (taken) throw new ConflictException('An account with this email already exists. Log in instead.');
    await this.dataSource.query(`DELETE FROM pending_registration WHERE expires_at < NOW() OR email = $1`, [email]);
    const id = randomBytes(16).toString('hex');
    const register: RegisterDto = { name: dto.name.trim(), email, password: dto.password, company: { name: dto.company.name.trim(), category: (dto.company.category === 'service' ? 'service' : 'product') } };
    const payload = this.encrypt(JSON.stringify({ register, category: dto.company.category ?? 'product' }));
    await this.dataSource.query(
      `INSERT INTO pending_registration (id, email, whatsapp, payload, expires_at) VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5::int))`,
      [id, email, whatsapp, payload, REGISTRATION_TTL_MIN]);
    const emailResult = await this.issue('register_email', id, email, 'email', `Welcome to ${BrandingService.current().name}! Use this code to confirm your email address.`);
    const phoneResult = await this.issue('register_whatsapp', id, whatsapp, 'whatsapp', '').catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    return {
      registration_id: id, email, whatsapp,
      email_sent: true, whatsapp_sent: !('error' in phoneResult), whatsapp_error: 'error' in phoneResult ? phoneResult.error : null,
      ...(otpDevMode() ? { dev_codes: { email: (emailResult as { dev_code?: string }).dev_code, whatsapp: (phoneResult as { dev_code?: string }).dev_code } } : {}),
    };
  }

  async registerResend(dto: RegisterResendDto) {
    const [pending] = await this.dataSource.query(`SELECT * FROM pending_registration WHERE id = $1 AND expires_at > NOW()`, [dto.registration_id]);
    if (!pending) throw new NotFoundException('This sign-up has expired. Please start again.');
    return dto.channel === 'email'
      ? this.issue('register_email', pending.id, pending.email, 'email', 'Use this code to confirm your email address.')
      : this.issue('register_whatsapp', pending.id, pending.whatsapp, 'whatsapp', '');
  }

  async registerVerify(dto: RegisterVerifyDto) {
    const [pending] = await this.dataSource.query(`SELECT * FROM pending_registration WHERE id = $1 AND expires_at > NOW()`, [dto.registration_id]);
    if (!pending) throw new NotFoundException('This sign-up has expired. Please start again.');
    await this.check('register_email', pending.id, dto.email_code);
    await this.check('register_whatsapp', pending.id, dto.whatsapp_code);
    const { register, category } = JSON.parse(this.decrypt(pending.payload)) as { register: RegisterDto; category: string };
    await this.authService.register(register); // same account + company creation as before
    const [user] = await this.dataSource.query(`SELECT id, company_id FROM app_user WHERE LOWER(email) = $1`, [pending.email]);
    await this.dataSource.query(`UPDATE app_user SET email_verified_at = NOW(), whatsapp_number = $2, whatsapp_verified_at = NOW() WHERE id = $1`, [user.id, pending.whatsapp]);
    await this.dataSource.query(
      `UPDATE companies SET phone = COALESCE(NULLIF(phone, ''), $2), business_category = $3 WHERE id = $1`,
      [user.company_id, pending.whatsapp, category === 'service' || category === 'both' ? category : 'product']);
    await this.dataSource.query(`DELETE FROM pending_registration WHERE id = $1`, [pending.id]);
    return this.authService.issueAuthResponse(Number(user.id));
  }

  /* ───── Change email / WhatsApp (signed in) ───── */

  async changeEmailStart(user: AuthenticatedUser, dto: ChangeEmailStartDto) {
    const email = dto.new_email.trim().toLowerCase();
    const [me] = await this.dataSource.query(`SELECT email FROM app_user WHERE id = $1`, [user.id]);
    if (!me) throw new UnauthorizedException();
    if (me.email.toLowerCase() === email) throw new BadRequestException('This is already your email.');
    const [taken] = await this.dataSource.query(`SELECT 1 FROM app_user WHERE LOWER(email) = $1`, [email]);
    if (taken) throw new ConflictException('Another account already uses this email.');
    try {
      await this.authService.login({ email: me.email, password: dto.password });
    } catch {
      throw new UnauthorizedException('Your password is not correct.');
    }
    return this.issue('change_email', `user-${user.id}`, email, 'email', `Use this code to confirm your new email address for ${BrandingService.current().name}.`);
  }

  async changeEmailVerify(user: AuthenticatedUser, dto: CodeDto) {
    const email = await this.check('change_email', `user-${user.id}`, dto.code);
    const [taken] = await this.dataSource.query(`SELECT 1 FROM app_user WHERE LOWER(email) = $1 AND id <> $2`, [email, user.id]);
    if (taken) throw new ConflictException('Another account already uses this email.');
    await this.dataSource.query(`UPDATE app_user SET email = $2, email_verified_at = NOW() WHERE id = $1`, [user.id, email]);
    // the business email follows the admin's login email
    await this.dataSource.query(`UPDATE companies SET email = '' WHERE admin_user_id = $1`, [user.id]);
    return this.authService.issueAuthResponse(Number(user.id));
  }

  async changeWhatsappStart(user: AuthenticatedUser, dto: ChangeWhatsappStartDto) {
    const whatsapp = normalizeWhatsapp(dto.whatsapp);
    if (whatsapp.length < 10 || whatsapp.length > 15) throw new BadRequestException('Enter the WhatsApp number with the country code.');
    return this.issue('change_whatsapp', `user-${user.id}`, whatsapp, 'whatsapp', '');
  }

  async changeWhatsappVerify(user: AuthenticatedUser, dto: CodeDto) {
    const whatsapp = await this.check('change_whatsapp', `user-${user.id}`, dto.code);
    await this.dataSource.query(`UPDATE app_user SET whatsapp_number = $2, whatsapp_verified_at = NOW() WHERE id = $1`, [user.id, whatsapp]);
    return { whatsapp_number: whatsapp };
  }

  /* ───── Forgot password ───── */

  /** Sends a reset code to the account email. The answer is the same whether the email exists or not. */
  async forgotPasswordStart(dto: ForgotPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const generic = { sent: true, message: 'If an account uses this email, a 6-digit code was sent to it.' };
    const [user] = await this.dataSource.query(
      `SELECT id, access_disabled FROM app_user WHERE LOWER(email) = $1`, [email]);
    if (!user || user.access_disabled) return generic;
    try {
      const result = await this.issue('reset_password', `reset-${user.id}`, email, 'email',
        `Use this code to reset your ${BrandingService.current().name} password. If you did not ask for it, you can ignore this email.`);
      return { ...generic, ...(otpDevMode() ? { dev_code: (result as { dev_code?: string }).dev_code } : {}) };
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw error;
      return generic;
    }
  }

  async forgotPasswordReset(dto: ResetPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const [user] = await this.dataSource.query(
      `SELECT id, access_disabled FROM app_user WHERE LOWER(email) = $1`, [email]);
    if (!user || user.access_disabled) throw new BadRequestException('The code is not correct. Ask for a new code.');
    await this.check('reset_password', `reset-${user.id}`, dto.code);
    await this.authService.setPassword(Number(user.id), dto.new_password);
    return { reset: true, message: 'Your password was changed. Log in with the new password.' };
  }
}

@Controller('auth')
@ApiTags('Auth')
export class VerificationController {
  constructor(private readonly service: VerificationService) {}

  /** 1) Sign-up details → codes sent to email and WhatsApp */
  @Post('register/start')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  start(@Body() dto: RegisterStartDto) { return this.service.registerStart(dto); }

  @Post('register/resend')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  resend(@Body() dto: RegisterResendDto) { return this.service.registerResend(dto); }

  /** 2) Both codes → account created, logged in */
  @Post('register/verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@Body() dto: RegisterVerifyDto) { return this.service.registerVerify(dto); }

  @Post('change-email/start')
  @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  changeEmailStart(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangeEmailStartDto) { return this.service.changeEmailStart(user, dto); }

  @Post('change-email/verify')
  @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  changeEmailVerify(@CurrentUser() user: AuthenticatedUser, @Body() dto: CodeDto) { return this.service.changeEmailVerify(user, dto); }

  @Post('change-whatsapp/start')
  @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  changeWhatsappStart(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangeWhatsappStartDto) { return this.service.changeWhatsappStart(user, dto); }

  @Post('change-whatsapp/verify')
  @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  changeWhatsappVerify(@CurrentUser() user: AuthenticatedUser, @Body() dto: CodeDto) { return this.service.changeWhatsappVerify(user, dto); }

  /** Forgot password: 1) email → code sent  2) email + code + new password */
  @Post('password/forgot')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) { return this.service.forgotPasswordStart(dto); }

  @Post('password/reset')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resetPassword(@Body() dto: ResetPasswordDto) { return this.service.forgotPasswordReset(dto); }
}

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([])],
  controllers: [VerificationController],
  providers: [VerificationService],
})
export class VerificationModule {}
