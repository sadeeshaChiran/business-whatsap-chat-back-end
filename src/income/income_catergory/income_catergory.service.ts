import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateIncomeCatergoryDto } from './dto/create-income_catergory.dto';
import { UpdateIncomeCatergoryDto } from './dto/update-income_catergory.dto';
import { IncomeCatergory } from './entities/income_catergory.entity';

@Injectable()
export class IncomeCatergoryService {
  constructor(
    @InjectRepository(IncomeCatergory)
    private readonly incomeCategoryRepository: Repository<IncomeCatergory>,
  ) {}

  async create(createIncomeCatergoryDto: CreateIncomeCatergoryDto) {
    const category = this.incomeCategoryRepository.create({
      ...createIncomeCatergoryDto,
      is_common: createIncomeCatergoryDto.is_common ?? false,
      is_active: createIncomeCatergoryDto.is_active ?? true,
    });

    return this.incomeCategoryRepository.save(category);
  }

  async findAll() {
    return this.incomeCategoryRepository.find({
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number) {
    const category = await this.incomeCategoryRepository.findOne({
      where: { id },
    });

    if (!category) {
      throw new NotFoundException('Income category not found');
    }

    return category;
  }

  async update(id: number, updateIncomeCatergoryDto: UpdateIncomeCatergoryDto) {
    const category = await this.findOne(id);

    this.incomeCategoryRepository.merge(category, updateIncomeCatergoryDto);
    return this.incomeCategoryRepository.save(category);
  }

  async remove(id: number) {
    const category = await this.findOne(id);
    await this.incomeCategoryRepository.remove(category);

    return { id };
  }
}
