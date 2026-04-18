import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { NoteColorTags } from './color_tags/entities/color_tag.entity';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';
import { Note } from './entities/note.entity';

@Injectable()
export class NotesService {
  constructor(
    @InjectRepository(Note)
    private readonly noteRepository: Repository<Note>,
    @InjectRepository(NoteColorTags)
    private readonly colorTagRepository: Repository<NoteColorTags>,
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
      where: [
        { id, company: { id: companyId } },
        { id, is_common: true },
      ],
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

  async createMany(createNoteDtos: CreateNoteDto[], user: AuthenticatedUser) {
    const colorTags = await Promise.all(
      createNoteDtos.map((note) =>
        this.findOwnedColorTag(note.color_tag_id, user.company_id),
      ),
    );

    const notes = createNoteDtos.map((note, index) =>
      this.noteRepository.create({
        title: note.title.trim(),
        content: note.content.trim(),
        created_user_id: user.id,
        company: { id: user.company_id },
        color_tag: colorTags[index],
      }),
    );

    return this.noteRepository.save(notes);
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

  async update(
    id: number,
    updateNoteDto: UpdateNoteDto,
    user: AuthenticatedUser,
  ) {
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

  async selectNotesForAi(userId: number, noteIds: number[], user: AuthenticatedUser) {
    const uniqueNoteIds = [...new Set(noteIds)];

    if (uniqueNoteIds.length > 3) {
      throw new BadRequestException('A maximum of 3 notes can be selected for AI');
    }

    const ownedNotes = uniqueNoteIds.length
      ? await this.noteRepository.find({
          where: {
            id: In(uniqueNoteIds),
            company: { id: user.company_id },
            created_user_id: userId,
          },
          select: {
            id: true,
          },
        })
      : [];

    if (ownedNotes.length !== uniqueNoteIds.length) {
      throw new BadRequestException('One or more notes do not belong to the user');
    }

    await this.noteRepository.manager.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .update(Note)
        .set({ is_selected_for_ai: false })
        .where('company_id = :companyId', { companyId: user.company_id })
        .andWhere('created_user_id = :userId', { userId })
        .execute();

      if (uniqueNoteIds.length) {
        await manager
          .createQueryBuilder()
          .update(Note)
          .set({ is_selected_for_ai: true })
          .where('company_id = :companyId', { companyId: user.company_id })
          .andWhere('created_user_id = :userId', { userId })
          .andWhere('id IN (:...noteIds)', { noteIds: uniqueNoteIds })
          .execute();
      }
    });

    return this.getSelectedNotes(userId, user);
  }

  async getSelectedNotes(userId: number, user: AuthenticatedUser) {
    return this.noteRepository.find({
      where: {
        company: { id: user.company_id },
        created_user_id: userId,
        is_selected_for_ai: true,
      },
      select: {
        id: true,
        title: true,
        content: true,
        created_user_id: true,
        is_selected_for_ai: true,
        created_at: true,
        updated_at: true,
      },
      order: { updated_at: 'DESC' },
    });
  }
}
