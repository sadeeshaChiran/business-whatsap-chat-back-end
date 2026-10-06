import { BrandingService } from '../platform/branding.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, createVerify, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { Company } from '../company/entities/company.entity';
import { Industry } from '../company/industry/entities/industry.entity';
import { User } from '../users/entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthenticatedUser, UserRole } from './interfaces/authenticated-user.interface';

interface JwtPayload {
  sub: number;
  name: string;
  email: string;
  company_id: number;
  /** token version – must match app_user.token_version */
  tv?: number;
  iat: number;
  exp: number;
}

interface GoogleTokenPayload {
  iss: string;
  aud: string;
  exp: number;
  email: string;
  email_verified: boolean | string;
  name?: string;
}

/** Account data checked on every request (kept in memory for a few seconds). */
interface CachedAccount {
  user: AuthenticatedUser;
  tokenVersion: number;
  blockedReason: string | null;
  expiresAt: number;
}

const ACCOUNT_CACHE_MS = 15_000;
const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;
const INVALID_LOGIN = 'Invalid email or password.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret: string;
  private readonly jwtSecrets: string[];
  private readonly jwtTtlSeconds = Number(process.env.JWT_TTL_SECONDS ?? 60 * 60 * 24 * 7);
  private googleCertCache: { certs: Record<string, string>; expiresAt: number } | null = null;
  private readonly accountCache = new Map<number, CachedAccount>();

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(Industry)
    private readonly industryRepository: Repository<Industry>,
  ) {
    const secret = process.env.JWT_SECRET?.trim();
    if (!secret) {
      throw new Error('JWT_SECRET is required. Set a long random value (64+ characters) in .env');
    }
    if (secret.length < 32) {
      this.logger.warn('JWT_SECRET is shorter than 32 characters. Use a long random value in production.');
    }
    this.jwtSecret = secret;
    // JWT_SECRET_LEGACY lets old tokens keep working for one rotation period.
    const legacy = process.env.JWT_SECRET_LEGACY?.trim();
    this.jwtSecrets = legacy && legacy !== secret ? [secret, legacy] : [secret];
  }

  /* ───────────────────────── Registration ───────────────────────── */

  private async getRegistrationIndustry(): Promise<Industry> {
    const existing = await this.industryRepository.find({ order: { id: 'ASC' }, take: 1 });
    if (existing.length > 0) return existing[0];
    return this.industryRepository.save(this.industryRepository.create({ name: 'General', is_active: true }));
  }

  /** Old one-step sign-up (no codes). Blocked unless REGISTRATION_VERIFICATION=false – use /auth/register/start. */
  async registerUnverified(registerDto: RegisterDto) {
    if (String(process.env.REGISTRATION_VERIFICATION ?? 'true').trim().toLowerCase() !== 'false') {
      throw new BadRequestException('Please sign up with email and WhatsApp verification.');
    }
    return this.register(registerDto);
  }

  /** Creates the company + its admin account. */
  async register(registerDto: RegisterDto) {
    const email = registerDto.email.trim().toLowerCase();
    const existingUser = await this.findByEmail(email);
    if (existingUser) throw new ConflictException('An account with this email already exists. Log in instead.');

    const industry = await this.getRegistrationIndustry();
    const savedCompany = await this.companyRepository.save(
      this.companyRepository.create({
        name: registerDto.company.name.trim(),
        status: 'ACTIVE',
        plan: '',
        email: '',
        phone: '',
        address: '',
        industry_id: industry.id,
        is_email_nofications: true,
        is_weekly_report: true,
        is_monthly_report: true,
        business_category: registerDto.company.category ?? 'product',
        order_collect_customer_info: true,
        order_collect_products: true,
        order_allow_note: true,
        bot_enabled: false,
      }),
    );

    const user = await this.userRepository.save(
      this.userRepository.create({
        name: registerDto.name.trim(),
        email,
        password_hash: this.hashPassword(registerDto.password),
        company_id: Number(savedCompany.id),
        is_agent_active: false,
        password_changed_at: new Date(),
      }),
    );

    savedCompany.admin_user_id = user.id;
    await this.companyRepository.save(savedCompany);
    return this.buildAuthResponse(user, savedCompany);
  }

  /* ───────────────────────── Login ───────────────────────── */

  async login(loginDto: LoginDto) {
    const email = loginDto.email.trim().toLowerCase();
    const user = await this.userRepository
      .createQueryBuilder('u')
      .addSelect(['u.failed_login_count', 'u.locked_until'])
      .where('LOWER(u.email) = :email', { email })
      .getOne();

    if (!user) {
      // same work as a real check so response time does not reveal which emails exist
      this.verifyPassword(loginDto.password, `${'0'.repeat(32)}:${'0'.repeat(128)}`);
      throw new UnauthorizedException(INVALID_LOGIN);
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new HttpException(
        `Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes or reset your password.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!this.verifyPassword(loginDto.password, user.password_hash)) {
      const failed = Number(user.failed_login_count ?? 0) + 1;
      await this.userRepository.update(user.id, {
        failed_login_count: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        locked_until: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      });
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    const company = await this.resolveCompanyProfile(user);
    this.assertCanSignIn(user, company);

    // Logging in brings an agent back to "available" (work status), and clears failed attempts.
    await this.userRepository.update(user.id, {
      is_active: true,
      failed_login_count: 0,
      locked_until: null,
      last_login_at: new Date(),
    });
    user.is_active = true;
    return this.buildAuthResponse(user, company);
  }

  /** "Sign in with Google" for existing accounts. New workspaces must sign up with email + WhatsApp codes. */
  async googleAuth(googleAuthDto: GoogleAuthDto) {
    const googleUser = await this.verifyGoogleCredential(googleAuthDto.credential);
    const user = await this.findByEmail(googleUser.email.trim().toLowerCase());
    if (!user) {
      throw new UnauthorizedException(`No ${BrandingService.current().name} account uses this Google email. Sign up first.`);
    }
    const company = await this.resolveCompanyProfile(user);
    this.assertCanSignIn(user, company);
    await this.userRepository.update(user.id, { is_active: true, last_login_at: new Date() });
    user.is_active = true;
    return this.buildAuthResponse(user, company);
  }

  private assertCanSignIn(user: User, company: Company | null) {
    if (user.access_disabled) {
      throw new ForbiddenException('Your access was removed by your company admin.');
    }
    if (!user.is_super_admin && company && String(company.status ?? '').toUpperCase() === 'SUSPENDED') {
      throw new ForbiddenException(suspendedMessage());
    }
  }

  /* ───────────────────────── Passwords ───────────────────────── */

  async changePassword(userId: number, currentPassword: string, newPassword: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Please log in to continue.');
    if (!this.verifyPassword(currentPassword, user.password_hash)) {
      throw new BadRequestException('Your current password is not correct.');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException('The new password must be different from the current one.');
    }
    await this.setPassword(user.id, newPassword);
    // the user stays signed in on this device with a fresh token; other devices are signed out
    return this.issueAuthResponse(user.id);
  }

  /** Sets a new password and signs the account out everywhere (token version +1). */
  async setPassword(userId: number, newPassword: string) {
    await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({
        password_hash: this.hashPassword(newPassword),
        password_changed_at: new Date(),
        failed_login_count: 0,
        locked_until: null,
        token_version: () => 'token_version + 1',
      })
      .where('id = :id', { id: userId })
      .execute();
    this.invalidateAccount(userId);
  }

  /** Signs the account out on all devices. */
  async revokeSessions(userId: number) {
    await this.userRepository
      .createQueryBuilder()
      .update(User)
      .set({ token_version: () => 'token_version + 1' })
      .where('id = :id', { id: userId })
      .execute();
    this.invalidateAccount(userId);
  }

  /** Forget cached account data so the next request reads the database. */
  invalidateAccount(userId: number) {
    this.accountCache.delete(Number(userId));
  }

  /** Forget cached account data for every member of a company (suspend / plan change). */
  invalidateCompany(companyId: number) {
    for (const [id, cached] of this.accountCache) {
      if (cached.user.company_id === Number(companyId)) this.accountCache.delete(id);
    }
  }

  /* ───────────────────────── Profile ───────────────────────── */

  async getProfile(userId: number) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Please log in to continue.');
    const company = await this.resolveCompanyProfile(user);
    return this.serializeUser(user, company);
  }

  /** Login response (token + user) for an existing user – used by the verified sign-up and email change. */
  async issueAuthResponse(userId: number) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Please log in to continue.');
    const company = await this.resolveCompanyProfile(user);
    return this.buildAuthResponse(user, company);
  }

  private async findByEmail(email: string) {
    return this.userRepository
      .createQueryBuilder('u')
      .where('LOWER(u.email) = :email', { email: email.toLowerCase() })
      .getOne();
  }

  private async resolveCompanyProfile(user: User): Promise<Company | null> {
    if (!user.company_id) return null;
    return this.companyRepository.findOne({ where: { id: user.company_id } });
  }

  private roleOf(user: User, company: Company | null): UserRole {
    if (user.is_super_admin) return 'super_admin';
    if (company && Number(company.admin_user_id) === Number(user.id)) return 'admin';
    return 'agent';
  }

  /* ───────────────────────── Tokens ───────────────────────── */

  /**
   * Full request check: signature + expiry, then the account (exists, access not removed,
   * password not changed since the token was issued, workspace not suspended).
   */
  async authenticate(token: string): Promise<AuthenticatedUser> {
    const payload = this.verifyToken(token);
    const account = await this.loadAccount(Number(payload.sub));
    if (!account) throw new UnauthorizedException('Your session has ended. Please log in again.');
    if (Number(payload.tv ?? 0) !== account.tokenVersion) {
      throw new UnauthorizedException('Your session has ended. Please log in again.');
    }
    if (account.blockedReason) throw new ForbiddenException(account.blockedReason);
    return account.user;
  }

  private async loadAccount(userId: number): Promise<CachedAccount | null> {
    if (!Number.isFinite(userId) || userId <= 0) return null;
    const cached = this.accountCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.accountCache.delete(userId);
      return null;
    }
    const company = await this.resolveCompanyProfile(user);
    const role = this.roleOf(user, company);
    let blockedReason: string | null = null;
    if (user.access_disabled) blockedReason = 'Your access was removed by your company admin.';
    else if (role !== 'super_admin' && company && String(company.status ?? '').toUpperCase() === 'SUSPENDED') {
      blockedReason = suspendedMessage();
    } else if (role !== 'super_admin' && !company) {
      blockedReason = 'Your account is not linked to a workspace.';
    }

    const account: CachedAccount = {
      user: {
        id: Number(user.id),
        name: user.name,
        email: user.email,
        company_id: user.company_id != null ? Number(user.company_id) : 0,
        role,
        is_super_admin: Boolean(user.is_super_admin),
      },
      tokenVersion: Number(user.token_version ?? 0),
      blockedReason,
      expiresAt: Date.now() + ACCOUNT_CACHE_MS,
    };
    if (this.accountCache.size > 5000) this.accountCache.clear();
    this.accountCache.set(userId, account);
    return account;
  }

  /** Signature + expiry only. Use authenticate() for requests. */
  verifyToken(token: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Your session is not valid. Please log in again.');
    const [encodedHeader, encodedPayload, signature] = parts;

    let header: { alg?: string };
    let payload: JwtPayload;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg?: string };
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as JwtPayload;
    } catch {
      throw new UnauthorizedException('Your session is not valid. Please log in again.');
    }
    if (header.alg !== 'HS256') throw new UnauthorizedException('Your session is not valid. Please log in again.');
    if (!this.isValidSignature(`${encodedHeader}.${encodedPayload}`, signature)) {
      throw new UnauthorizedException('Your session is not valid. Please log in again.');
    }
    if (!payload.sub || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Your session has expired. Please log in again.');
    }
    return payload;
  }

  private buildAuthResponse(user: User, company: Company | null) {
    return {
      access_token: this.generateToken(user),
      token_type: 'Bearer',
      expires_in: this.jwtTtlSeconds,
      user: this.serializeUser(user, company),
    };
  }

  private serializeUser(user: User, company: Company | null) {
    return {
      id: Number(user.id),
      name: user.name,
      email: user.email,
      company_id: user.company_id != null ? Number(user.company_id) : 0,
      company_name: company?.name,
      business_category: company?.business_category ?? 'product',
      role: this.roleOf(user, company),
      is_active: user.is_active,
      is_agent_active: Boolean(user.is_agent_active),
      /** Metrocoding team (Agent Metra platform admin) */
      is_super_admin: Boolean(user.is_super_admin),
      email_verified: Boolean(user.email_verified_at),
      whatsapp_number: user.whatsapp_number ?? null,
      whatsapp_verified: Boolean(user.whatsapp_verified_at),
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  private generateToken(user: User): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: JwtPayload = {
      sub: Number(user.id),
      name: user.name,
      email: user.email,
      company_id: user.company_id != null ? Number(user.company_id) : 0,
      tv: Number(user.token_version ?? 0),
      iat: now,
      exp: now + this.jwtTtlSeconds,
    };
    const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signedContent = `${encodedHeader}.${encodedPayload}`;
    return `${signedContent}.${this.signContent(signedContent)}`;
  }

  private signContent(content: string, secret = this.jwtSecret): string {
    return createHmac('sha256', secret).update(content).digest('base64url');
  }

  private isValidSignature(content: string, signature: string): boolean {
    return this.jwtSecrets.some((secret) => this.safeCompare(signature, this.signContent(content, secret)));
  }

  private safeCompare(value: string, expectedValue: string): boolean {
    const valueBuffer = Buffer.from(value);
    const expectedBuffer = Buffer.from(expectedValue);
    if (valueBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(valueBuffer, expectedBuffer);
  }

  /* ───────────────────────── Google ───────────────────────── */

  private async verifyGoogleCredential(credential: string): Promise<GoogleTokenPayload> {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (!clientId) throw new BadRequestException('Google sign-in is not configured.');

    const [encodedHeader, encodedPayload, signature] = credential.split('.');
    if (!encodedHeader || !encodedPayload || !signature) throw new UnauthorizedException('Invalid Google credential.');

    let header: { alg?: string; kid?: string };
    let payload: GoogleTokenPayload;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Invalid Google credential.');
    }

    if (header.alg !== 'RS256' || !header.kid) throw new UnauthorizedException('Unsupported Google credential.');
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) {
      throw new UnauthorizedException('Invalid Google credential issuer.');
    }
    if (payload.aud !== clientId) throw new UnauthorizedException('Invalid Google credential audience.');
    if (!payload.email || payload.email_verified !== true) throw new UnauthorizedException('Google email is not verified.');
    if (payload.exp <= Math.floor(Date.now() / 1000)) throw new UnauthorizedException('Google credential has expired.');

    const cert = await this.getGoogleCertificate(header.kid);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    if (!verifier.verify(cert, Buffer.from(signature, 'base64url'))) {
      throw new UnauthorizedException('Invalid Google credential signature.');
    }
    return payload;
  }

  private async getGoogleCertificate(kid: string): Promise<string> {
    const now = Date.now();
    const cachedCert = this.googleCertCache && this.googleCertCache.expiresAt > now ? this.googleCertCache.certs[kid] : undefined;
    if (cachedCert) return cachedCert;

    const response = await fetch('https://www.googleapis.com/oauth2/v1/certs');
    if (!response.ok) throw new UnauthorizedException('Unable to verify Google credential.');
    const certs = (await response.json()) as Record<string, string>;
    const maxAgeMatch = (response.headers.get('cache-control') ?? '').match(/max-age=(\d+)/);
    this.googleCertCache = { certs, expiresAt: now + (maxAgeMatch ? Number(maxAgeMatch[1]) : 3600) * 1000 };
    const cert = certs[kid];
    if (!cert) throw new UnauthorizedException('Unknown Google credential key.');
    return cert;
  }

  /* ───────────────────────── Hashing ───────────────────────── */

  hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  verifyPassword(password: string, storedValue: string): boolean {
    const [salt, storedHash] = String(storedValue ?? '').split(':');
    if (!salt || !storedHash) return false;
    const computedHash = scryptSync(password, salt, 64).toString('hex');
    return this.safeCompare(computedHash, storedHash);
  }
}

/** Suspended workspace message with the platform support contact. */
function suspendedMessage() {
  const brand = BrandingService.current();
  const contact = brand.support_email || brand.support_phone || brand.whatsapp;
  return `This workspace is suspended. Please contact ${brand.name} support${contact ? ` (${contact})` : ''}.`;
}
