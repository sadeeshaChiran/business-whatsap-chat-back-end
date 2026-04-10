import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { Company } from './entities/company.entity';
import { Industry } from './industry/entities/industry.entity';

@Injectable()
export class CompanyService {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(Industry)
    private readonly industryRepository: Repository<Industry>,
  ) {}

  private async getIndustryOrFail(id: number): Promise<Industry> {
    const industry = await this.industryRepository.findOne({ where: { id } });

    if (!industry) {
      throw new NotFoundException('Industry not found');
    }

    return industry;
  }

  private async findOwnedCompany(id: number) {
    const company = await this.companyRepository.findOne({
      where: { id },
      relations: {
        industry: true,
      },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    return company;
  }

  async create(_createCompanyDto: CreateCompanyDto, _user: AuthenticatedUser) {
    throw new ConflictException(
      'Authenticated users already belong to one company. Use update instead.',
    );
  }

  async findCurrent(user: AuthenticatedUser) {
    return this.companyRepository.findOne({
      where: { id: user.company_id },
      relations: {
        industry: true,
      },
    });
  }

  async findOne(id: number, user: AuthenticatedUser) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }

    return this.findOwnedCompany(id);
  }

  async update(
    id: number,
    updateCompanyDto: UpdateCompanyDto,
    user: AuthenticatedUser,
  ) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }

    const company = await this.findOwnedCompany(id);

    if (updateCompanyDto.industry_id !== undefined) {
      company.industry = await this.getIndustryOrFail(updateCompanyDto.industry_id);
    }

    this.companyRepository.merge(company, {
      ...(updateCompanyDto.name !== undefined
        ? { name: updateCompanyDto.name.trim() }
        : {}),
      ...(updateCompanyDto.plan !== undefined
        ? { plan: updateCompanyDto.plan.trim() }
        : {}),
      ...(updateCompanyDto.email !== undefined
        ? { email: updateCompanyDto.email.trim().toLowerCase() }
        : {}),
      ...(updateCompanyDto.phone !== undefined
        ? { phone: updateCompanyDto.phone.trim() }
        : {}),
      ...(updateCompanyDto.address !== undefined
        ? { address: updateCompanyDto.address.trim() }
        : {}),
      is_email_nofications: updateCompanyDto.is_email_nofications,
      is_weekly_report: updateCompanyDto.is_weekly_report,
      is_monthly_report: updateCompanyDto.is_monthly_report,
    });

    return this.companyRepository.save(company);
  }

  async remove(id: number, user: AuthenticatedUser) {
    if (id !== user.company_id) {
      throw new NotFoundException('Company not found');
    }

    const company = await this.findOwnedCompany(id);
    await this.companyRepository.remove(company);

    return { id };
  }
}
