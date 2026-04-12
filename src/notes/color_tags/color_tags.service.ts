import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CreateNoteColorTagsDto } from './dto/create-color_tag.dto';
import { UpdateNoteColorTagsDto } from './dto/update-color_tag.dto';
import { NoteColorTags } from './entities/color_tag.entity';

@Injectable()
export class NoteColorTagsService {
  constructor(
    @InjectRepository(NoteColorTags)
    private readonly noteColorTagsRepository: Repository<NoteColorTags>,
  ) {}

  private async findOwnedNoteColorTags(id: number, companyId: number) {
    const noteColorTags = await this.noteColorTagsRepository.findOne({
      where: [
        { id, company: { id: companyId } },
        { id, is_common: true },
      ],
      relations: ['company'],
    });

    if (!noteColorTags) {
      throw new NotFoundException('Color tag not found');
    }

    return noteColorTags;
  }

  async create(createNoteColorTagsDto: CreateNoteColorTagsDto, user: AuthenticatedUser) {
    if (
      !createNoteColorTagsDto.is_common &&
      createNoteColorTagsDto.company_id !== user.company_id
    ) {
      throw new ForbiddenException(
        'You can only create color tags for your company',
      );
    }

    const noteColorTags = this.noteColorTagsRepository.create({
      color_code: createNoteColorTagsDto.color_code.trim(),
      meaning: createNoteColorTagsDto.meaning.trim(),
      is_common: createNoteColorTagsDto.is_common ?? false,
      company: createNoteColorTagsDto.is_common
        ? null
        : { id: createNoteColorTagsDto.company_id },
    });

    return this.noteColorTagsRepository.save(noteColorTags);
  }

  async createMany(
    createNoteColorTagsDtos: CreateNoteColorTagsDto[],
    user: AuthenticatedUser,
  ) {
    const noteColorTags = createNoteColorTagsDtos.map((colorTag) => {
      if (!colorTag.is_common && colorTag.company_id !== user.company_id) {
        throw new ForbiddenException(
          'You can only create color tags for your company',
        );
      }

      return this.noteColorTagsRepository.create({
        color_code: colorTag.color_code.trim(),
        meaning: colorTag.meaning.trim(),
        is_common: colorTag.is_common ?? false,
        company: colorTag.is_common ? null : { id: colorTag.company_id },
      });
    });

    return this.noteColorTagsRepository.save(noteColorTags);
  }

  async findAll(user: AuthenticatedUser) {
    return this.noteColorTagsRepository.find({
      where: [{ company: { id: user.company_id } }, { is_common: true }],
      order: { id: 'DESC' },
    });
  }

  async findColorCodesByCompany(user: AuthenticatedUser) {
    const noteColorTags = await this.noteColorTagsRepository.find({
      where: [{ company: { id: user.company_id } }, { is_common: true }],
      order: { id: 'DESC' },
    });

    return {
      company_id: user.company_id,
      color_codes: noteColorTags.map((tag) => tag.color_code),
    };
  }

  async findOne(id: number, user: AuthenticatedUser) {
    return this.findOwnedNoteColorTags(id, user.company_id);
  }

  async update(
    id: number,
    updateNoteColorTagsDto: UpdateNoteColorTagsDto,
    user: AuthenticatedUser,
  ) {
    const noteColorTags = await this.findOwnedNoteColorTags(id, user.company_id);

    if (updateNoteColorTagsDto.color_code !== undefined) {
      noteColorTags.color_code = updateNoteColorTagsDto.color_code.trim();
    }

    if (updateNoteColorTagsDto.meaning !== undefined) {
      noteColorTags.meaning = updateNoteColorTagsDto.meaning.trim();
    }
    
    if (updateNoteColorTagsDto.is_common !== undefined) {
        noteColorTags.is_common = updateNoteColorTagsDto.is_common;
        if (noteColorTags.is_common) {
            noteColorTags.company = null;
        }
    }

    return this.noteColorTagsRepository.save(noteColorTags);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const noteColorTags = await this.findOwnedNoteColorTags(id, user.company_id);
    await this.noteColorTagsRepository.remove(noteColorTags);

    return { id };
  }
}
