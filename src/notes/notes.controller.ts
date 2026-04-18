import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { NotesService } from './notes.service';
import { CreateManyNotesDto } from './dto/create-many-notes.dto';
import { CreateNoteDto } from './dto/create-note.dto';
import { SelectedNotesQueryDto } from './dto/selected-notes-query.dto';
import { SelectNotesForAiDto } from './dto/select-notes-for-ai.dto';
import { UpdateNoteDto } from './dto/update-note.dto';

@Controller('notes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Post()
  create(
    @Body() createNoteDto: CreateNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notesService.create(createNoteDto, user);
  }

  @Post('bulk')
  createMany(
    @Body() createManyNotesDto: CreateManyNotesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notesService.createMany(createManyNotesDto.items, user);
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.notesService.findAll(user);
  }

  @Get('company')
  findByCompany(@CurrentUser() user: AuthenticatedUser) {
    return this.notesService.findByCompany(user);
  }

  @Post('select-for-ai')
  selectForAi(
    @Body() selectNotesForAiDto: SelectNotesForAiDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (selectNotesForAiDto.user_id !== user.id) {
      throw new ForbiddenException('You can only manage your own selected notes');
    }

    return this.notesService.selectNotesForAi(
      selectNotesForAiDto.user_id,
      selectNotesForAiDto.note_ids,
      user,
    );
  }

  @Get('selected')
  getSelectedNotes(
    @Query() query: SelectedNotesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (query.user_id !== user.id) {
      throw new ForbiddenException('You can only view your own selected notes');
    }

    return this.notesService.getSelectedNotes(query.user_id, user);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notesService.findOne(id, user);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateNoteDto: UpdateNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notesService.update(id, updateNoteDto, user);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notesService.remove(id, user);
  }
}
