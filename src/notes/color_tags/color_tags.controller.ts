import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { NoteColorTagsService } from './color_tags.service';
import { CreateManyNoteColorTagsDto } from './dto/create-many-color_tags.dto';
import { CreateNoteColorTagsDto } from './dto/create-color_tag.dto';
import { UpdateNoteColorTagsDto } from './dto/update-color_tag.dto';

@Controller('color-tags')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class NoteColorTagsController {
  constructor(private readonly colorTagsService: NoteColorTagsService) {}

  @Post()
  create(
    @Body() createNoteColorTagsDto: CreateNoteColorTagsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.colorTagsService.create(createNoteColorTagsDto, user);
  }

  @Post('bulk')
  createMany(
    @Body() createManyNoteColorTagsDto: CreateManyNoteColorTagsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.colorTagsService.createMany(
      createManyNoteColorTagsDto.items,
      user,
    );
  }

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.colorTagsService.findAll(user);
  }

  @Get('color-codes')
  findColorCodesByCompany(@CurrentUser() user: AuthenticatedUser) {
    return this.colorTagsService.findColorCodesByCompany(user);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.colorTagsService.findOne(id, user);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateNoteColorTagsDto: UpdateNoteColorTagsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.colorTagsService.update(id, updateNoteColorTagsDto, user);
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.colorTagsService.remove(id, user);
  }
}
