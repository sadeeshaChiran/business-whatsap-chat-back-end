import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ColorTag } from './color_tags/entities/color_tag.entity';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';
import { Note } from './entities/note.entity';

@Injectable()
export class NotesService {
  constructor(
    @InjectRepository(Note)
    private readonly noteRepository: Repository<Note>,
    @InjectRepository(ColorTag)
    private readonly colorTagRepository: Repository<ColorTag>,
  ) {}

  private async findOwnedNote(id: number, companyId: number) {
    const note = await this.noteRepository.findOne({
      where: { id, company: { id: companyId } },
      relations: ['color_tag', 'company'],
    });

    if (!note) {
      throw new NotFoundException('Note not found');
    }

    return note;
  }

  private async findOwnedColorTag(id: number, companyId: number) {
    const colorTag = await this.colorTagRepository.findOne({
      where: { id, company: { id: companyId } },
    });

    if (!colorTag) {
      throw new NotFoundException('Color tag not found');
    }

    return colorTag;
  }

  async create(createNoteDto: CreateNoteDto, user: AuthenticatedUser) {
    const colorTag = await this.findOwnedColorTag(
      createNoteDto.color_tag_id,
      user.company_id,
    );

    const note = this.noteRepository.create({
      title: createNoteDto.title.trim(),
      content: createNoteDto.content.trim(),
      created_user_id: user.id,
      company: { id: user.company_id },
      color_tag: colorTag,
    });

    return this.noteRepository.save(note);
  }

  async findAll(user: AuthenticatedUser) {
    return this.noteRepository.find({
      where: { company: { id: user.company_id } },
      relations: ['color_tag'],
      order: { id: 'DESC' },
    });
  }

  async findByCompany(user: AuthenticatedUser) {
    return this.noteRepository.find({
      where: { company: { id: user.company_id } },
      relations: ['color_tag'],
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number, user: AuthenticatedUser) {
    return this.findOwnedNote(id, user.company_id);
  }

  async update(id: number, updateNoteDto: UpdateNoteDto, user: AuthenticatedUser) {
    const note = await this.findOwnedNote(id, user.company_id);

    if (updateNoteDto.color_tag_id !== undefined) {
      note.color_tag = await this.findOwnedColorTag(
        updateNoteDto.color_tag_id,
        user.company_id,
      );
    }

    if (updateNoteDto.title !== undefined) {
      note.title = updateNoteDto.title.trim();
    }

    if (updateNoteDto.content !== undefined) {
      note.content = updateNoteDto.content.trim();
    }

    return this.noteRepository.save(note);
  }

  async remove(id: number, user: AuthenticatedUser) {
    const note = await this.findOwnedNote(id, user.company_id);
    await this.noteRepository.remove(note);

    return { id };
  }
}
