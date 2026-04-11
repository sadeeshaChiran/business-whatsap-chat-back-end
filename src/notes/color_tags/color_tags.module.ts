import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { NoteColorTagsService } from './color_tags.service';
import { NoteColorTagsController } from './color_tags.controller';
import { NoteColorTags } from './entities/color_tag.entity';

@Module({
  controllers: [NoteColorTagsController],
  providers: [NoteColorTagsService],
  imports: [TypeOrmModule.forFeature([NoteColorTags]), AuthModule],
})
export class NoteColorTagsModule {}
