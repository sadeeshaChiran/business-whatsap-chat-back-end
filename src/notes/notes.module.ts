import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { NotesService } from './notes.service';
import { NotesController } from './notes.controller';
import { ColorTag } from './color_tags/entities/color_tag.entity';
import { Note } from './entities/note.entity';

@Module({
  controllers: [NotesController],
  providers: [NotesService],
  imports: [TypeOrmModule.forFeature([Note, ColorTag]), AuthModule],
})
export class NotesModule {}
