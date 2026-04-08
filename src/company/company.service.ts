import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  async create(createCompanyDto: CreateCompanyDto) {
    const industry = await this.getIndustryOrFail(createCompanyDto.industry_id);

    const company = this.companyRepository.create({
      name: createCompanyDto.name,
      plan: createCompanyDto.plan,
      email: createCompanyDto.email,
      phone: createCompanyDto.phone,
      address: createCompanyDto.address,
      is_email_nofications: createCompanyDto.is_email_nofications ?? true,
      is_weekly_report: createCompanyDto.is_weekly_report ?? true,
      is_monthly_report: createCompanyDto.is_monthly_report ?? true,
      industry,
    });

    return this.companyRepository.save(company);
  }

  async findAll() {
    return this.companyRepository.find({
      relations: {
        industry: true,
      },
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number) {
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

  async update(id: number, updateCompanyDto: UpdateCompanyDto) {
    const company = await this.findOne(id);

    if (updateCompanyDto.industry_id !== undefined) {
      company.industry = await this.getIndustryOrFail(updateCompanyDto.industry_id);
    }

    this.companyRepository.merge(company, {
      name: updateCompanyDto.name,
      plan: updateCompanyDto.plan,
      email: updateCompanyDto.email,
      phone: updateCompanyDto.phone,
      address: updateCompanyDto.address,
      is_email_nofications: updateCompanyDto.is_email_nofications,
      is_weekly_report: updateCompanyDto.is_weekly_report,
      is_monthly_report: updateCompanyDto.is_monthly_report,
    });

    return this.companyRepository.save(company);
  }

  async remove(id: number) {
    const company = await this.findOne(id);
    await this.companyRepository.remove(company);

    return { id };
  }
}
