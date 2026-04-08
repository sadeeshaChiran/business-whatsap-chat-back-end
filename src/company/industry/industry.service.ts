import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateIndustryDto } from './dto/create-industry.dto';
import { UpdateIndustryDto } from './dto/update-industry.dto';
import { Industry } from './entities/industry.entity';

@Injectable()
export class IndustryService {
  constructor(
    @InjectRepository(Industry)
    private readonly industryRepository: Repository<Industry>,
  ) {}

  async create(createIndustryDto: CreateIndustryDto) {
    const industry = this.industryRepository.create({
      ...createIndustryDto,
      is_active: createIndustryDto.is_active ?? true,
    });

    return this.industryRepository.save(industry);
  }

  async findAll() {
    return this.industryRepository.find({
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number) {
    const industry = await this.industryRepository.findOne({
      where: { id },
    });

    if (!industry) {
      throw new NotFoundException('Industry not found');
    }

    return industry;
  }

  async update(id: number, updateIndustryDto: UpdateIndustryDto) {
    const industry = await this.findOne(id);

    this.industryRepository.merge(industry, updateIndustryDto);
    return this.industryRepository.save(industry);
  }

  async remove(id: number) {
    const industry = await this.findOne(id);
    await this.industryRepository.remove(industry);

    return { id };
  }
}
