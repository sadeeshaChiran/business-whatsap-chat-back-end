import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
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
    process.env.JWT_SECRET ?? 'business-health-scanner-secret';
  private readonly jwtTtlSeconds = Number(
    process.env.JWT_TTL_SECONDS ?? 60 * 60 * 24 * 7,
  );

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
  ) {}

  private async getRegistrationIndustry(
    manager: EntityManager,
  ): Promise<Industry> {
    const industryRepository = manager.getRepository(Industry);
    const existingIndustry = await industryRepository.find({
      order: { id: 'ASC' },
      take: 1,
    });

    if (existingIndustry.length > 0) {
      return existingIndustry[0];
    }

    const industry = industryRepository.create({
      name: 'General',
      is_active: true,
    });

    return industryRepository.save(industry);
  }

  async register(registerDto: RegisterDto) {
    const email = registerDto.email.trim().toLowerCase();
    const existingUser = await this.userRepository.findOne({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const persistedUser = await this.dataSource.transaction(async (manager) => {
      const industry = await this.getRegistrationIndustry(manager);

      const company = manager.getRepository(Company).create({
        name: registerDto.company.name.trim(),
        plan: '',
        email: '',
        phone: '',
        address: '',
        is_email_nofications: true,
        is_weekly_report: true,
        is_monthly_report: true,
        industry,
      });

      const savedCompany = await manager.getRepository(Company).save(company);

      const user = manager.getRepository(User).create({
        name: registerDto.name.trim(),
        email,
        password_hash: this.hashPassword(registerDto.password),
        company: savedCompany,
      });

      const savedUser = await manager.getRepository(User).save(user);

      savedCompany.admin_user_id = savedUser.id;
      await manager.getRepository(Company).save(savedCompany);

      return manager.getRepository(User).findOne({
        where: { id: savedUser.id },
        relations: {
          company: true,
        },
      });
    });

    if (!persistedUser) {
      throw new UnauthorizedException('Unable to load registered user');
    }

    return this.buildAuthResponse(persistedUser);
  }

  async login(loginDto: LoginDto) {
    const email = loginDto.email.trim().toLowerCase();
    const user = await this.userRepository.findOne({
      where: { email },
      relations: {
        company: true,
      },
    });

    if (!user || !user.is_active) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = this.verifyPassword(
      loginDto.password,
      user.password_hash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.buildAuthResponse(user);
  }

  async getProfile(userId: number) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: {
        company: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.serializeUser(user);
  }

  verifyToken(token: string): AuthenticatedUser {
    const [encodedHeader, encodedPayload, signature] = token.split('.');

    if (!encodedHeader || !encodedPayload || !signature) {
      throw new UnauthorizedException('Invalid token');
    }

    const signedContent = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = this.signContent(signedContent);

    if (!this.safeCompare(signature, expectedSignature)) {
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
    if (
      !payload.sub ||
      !payload.company_id ||
      payload.exp <= currentTimestamp
    ) {
      throw new UnauthorizedException('Token has expired or is invalid');
    }

    return {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      company_id: payload.company_id,
    };
  }

  private buildAuthResponse(user: User) {
    const accessToken = this.generateToken(user);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.jwtTtlSeconds,
      user: this.serializeUser(user),
    };
  }

  private serializeUser(user: User) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      company_id: user.company?.id,
      company_name: user.company?.name,
      is_active: user.is_active,
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
      company_id: user.company.id,
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
    const signature = this.signContent(signedContent);

    return `${signedContent}.${signature}`;
  }

  private signContent(content: string): string {
    return createHmac('sha256', this.jwtSecret)
      .update(content)
      .digest('base64url');
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
