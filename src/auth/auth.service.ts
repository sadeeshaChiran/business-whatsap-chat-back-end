import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { Company } from '../company/entities/company.entity';
import { Industry } from '../company/industry/entities/industry.entity';
import { User } from '../users/entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';

interface JwtPayload {
  sub: number;
  name: string;
  email: string;
  company_id: number;
  iat: number;
  exp: number;
}

@Injectable()
export class AuthService {
  private readonly jwtSecret =
    process.env.JWT_SECRET?.trim() || 'change-me';
  private readonly jwtSecrets: string[];
  private readonly jwtTtlSeconds = Number(
    process.env.JWT_TTL_SECONDS ?? 60 * 60 * 24 * 7,
  );

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(Industry)
    private readonly industryRepository: Repository<Industry>,
  ) {
    const legacySecret = process.env.JWT_SECRET_LEGACY?.trim();
    this.jwtSecrets = [
      this.jwtSecret,
      legacySecret,
      'business-health-scanner-secret',
    ].filter((secret, index, secrets): secret is string => {
      return Boolean(secret) && secrets.indexOf(secret) === index;
    });
  }

  private async getRegistrationIndustry(): Promise<Industry> {
    const existing = await this.industryRepository.find({
      order: { id: 'ASC' },
      take: 1,
    });
    if (existing.length > 0) {
      return existing[0];
    }
    return this.industryRepository.save(
      this.industryRepository.create({ name: 'General', is_active: true }),
    );
  }

  async register(registerDto: RegisterDto) {
    const email = registerDto.email.trim().toLowerCase();
    const existingUser = await this.userRepository.findOne({ where: { email } });
    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

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
      }),
    );

    const user = await this.userRepository.save(
      this.userRepository.create({
        name: registerDto.name.trim(),
        email,
        password_hash: this.hashPassword(registerDto.password),
        company_id: Number(savedCompany.id),
        is_agent_active: false,
      }),
    );

    savedCompany.admin_user_id = user.id;
    await this.companyRepository.save(savedCompany);

    return this.buildAuthResponse(user, savedCompany.name);
  }

  async login(loginDto: LoginDto) {
    const email = loginDto.email.trim().toLowerCase();
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!this.verifyPassword(loginDto.password, user.password_hash)) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.is_active) {
      user.is_active = true;
      await this.userRepository.save(user);
    }
    const companyName = await this.resolveCompanyName(user);
    return this.buildAuthResponse(user, companyName);
  }

  async getProfile(userId: number) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const companyName = await this.resolveCompanyName(user);
    return this.serializeUser(user, companyName);
  }

  private async resolveCompanyName(user: User): Promise<string | undefined> {
    if (!user.company_id) {
      return undefined;
    }
    const company = await this.companyRepository.findOne({
      where: { id: user.company_id },
    });
    return company?.name;
  }

  verifyToken(token: string): AuthenticatedUser {
    const [encodedHeader, encodedPayload, signature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !signature) {
      throw new UnauthorizedException('Invalid token');
    }
    const signedContent = `${encodedHeader}.${encodedPayload}`;
    if (!this.isValidSignature(signedContent, signature)) {
      throw new UnauthorizedException('Invalid token signature');
    }
    let payload: JwtPayload;
    try {
      payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid token payload');
    }
    const currentTimestamp = Math.floor(Date.now() / 1000);
    if (!payload.sub || payload.exp <= currentTimestamp) {
      throw new UnauthorizedException('Token has expired or is invalid');
    }
    return {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      company_id:
        payload.company_id != null ? Number(payload.company_id) : 0,
    };
  }

  private buildAuthResponse(user: User, companyName?: string) {
    return {
      access_token: this.generateToken(user),
      token_type: 'Bearer',
      expires_in: this.jwtTtlSeconds,
      user: this.serializeUser(user, companyName),
    };
  }

  private serializeUser(user: User, companyName?: string) {
    return {
      id: Number(user.id),
      name: user.name,
      email: user.email,
      company_id: user.company_id != null ? Number(user.company_id) : 0,
      company_name: companyName,
      is_active: user.is_active,
      is_agent_active: Boolean(user.is_agent_active),
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  private generateToken(user: User): string {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const payload: JwtPayload = {
      sub: user.id,
      name: user.name,
      email: user.email,
      // Postgres BIGINT can deserialize as string; normalize for route guards.
      company_id: user.company_id != null ? Number(user.company_id) : 0,
      iat: currentTimestamp,
      exp: currentTimestamp + this.jwtTtlSeconds,
    };
    const encodedHeader = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      'base64url',
    );
    const signedContent = `${encodedHeader}.${encodedPayload}`;
    return `${signedContent}.${this.signContent(signedContent)}`;
  }

  private signContent(content: string, secret = this.jwtSecret): string {
    return createHmac('sha256', secret).update(content).digest('base64url');
  }

  private isValidSignature(content: string, signature: string): boolean {
    return this.jwtSecrets.some((secret) =>
      this.safeCompare(signature, this.signContent(content, secret)),
    );
  }

  private safeCompare(value: string, expectedValue: string): boolean {
    const valueBuffer = Buffer.from(value);
    const expectedBuffer = Buffer.from(expectedValue);
    if (valueBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(valueBuffer, expectedBuffer);
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  private verifyPassword(password: string, storedValue: string): boolean {
    const [salt, storedHash] = storedValue.split(':');
    if (!salt || !storedHash) {
      return false;
    }
    const computedHash = scryptSync(password, salt, 64).toString('hex');
    return this.safeCompare(computedHash, storedHash);
  }
}
