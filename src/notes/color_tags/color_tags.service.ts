import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CreateColorTagDto } from './dto/create-color_tag.dto';
import { UpdateColorTagDto } from './dto/update-color_tag.dto';
import { ColorTag } from './entities/color_tag.entity';

@Injectable()
export class ColorTagsService {
  constructor(
    @InjectRepository(ColorTag)
    private readonly colorTagRepository: Repository<ColorTag>,
  ) {}

  private async findOwnedColorTag(id: number, companyId: number) {
    const colorTag = await this.colorTagRepository.findOne({
      where: { id, company: { id: companyId } },
      relations: ['company'],
    });

    if (!colorTag) {
      throw new NotFoundException('Color tag not found');
    }

    return colorTag;
  }

  async create(createColorTagDto: CreateColorTagDto, user: AuthenticatedUser) {
    if (createColorTagDto.company_id !== user.company_id) {
      throw new ForbiddenException(
        'You can only create color tags for your company',
      );
    }

    const colorTag = this.colorTagRepository.create({
      color_code: createColorTagDto.color_code.trim(),
      meaning: createColorTagDto.meaning.trim(),
      company: { id: createColorTagDto.company_id },
    });

    return this.colorTagRepository.save(colorTag);
  }

  async findAll(user: AuthenticatedUser) {
    return this.colorTagRepository.find({
      where: { company: { id: user.company_id } },
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number, user: AuthenticatedUser) {
    return this.findOwnedColorTag(id, user.company_id);
  }

  async update(
    id: number,
    updateColorTagDto: UpdateColorTagDto,
    user: AuthenticatedUser,
  ) {
    const colorTag = await this.findOwnedColorTag(id, user.company_id);

    if (updateColorTagDto.color_code !== undefined) {
      colorTag.color_code = updateColorTagDto.color_code.trim();
    }

    if (updateColorTagDto.meaning !== undefined) {
      colorTag.meaning = updateColorTagDto.meaning.trim();
    }

    return this.colorTagRepository.save(colorTag);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const colorTag = await this.findOwnedColorTag(id, user.company_id);
    await this.colorTagRepository.remove(colorTag);

    return { id };
  }
}
