import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { ColorTagsService } from './color_tags.service';
import { ColorTagsController } from './color_tags.controller';
import { ColorTag } from './entities/color_tag.entity';

@Module({
  controllers: [ColorTagsController],
  providers: [ColorTagsService],
  imports: [TypeOrmModule.forFeature([ColorTag]), AuthModule],
})
export class ColorTagsModule {}
