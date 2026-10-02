import { Body, Controller, Delete, Get, Module, Param, ParseIntPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { FeatureGuard, RequiresFeature } from '../platform/feature.guard';
import { SalesBotModule } from '../sales-bot/sales-bot.module';
import { SocialService } from './social.service';

class CommentsQueryDto {
  @IsOptional() @IsIn(['open', 'replied', 'hidden', 'done', 'all']) status?: string;
  @IsOptional() @IsIn(['facebook', 'instagram']) platform?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}
class MessageDto {
  @IsString() @MinLength(1) @MaxLength(2000) message: string;
}
class HideDto {
  @IsBoolean() hidden: boolean;
}
class DoneDto {
  @IsBoolean() done: boolean;
}
class SettingsDto {
  @IsOptional() @IsIn(['off', 'suggest', 'reply']) auto_reply?: string;
  @IsOptional() @IsBoolean() auto_dm?: boolean;
  @IsOptional() @IsBoolean() auto_hide_spam?: boolean;
}
class CaptionDto {
  @IsString() @MinLength(3) @MaxLength(1500) topic: string;
  @IsOptional() @IsIn(['english', 'sinhala', 'singlish', 'tamil']) language?: string;
  @IsOptional() @IsString() @MaxLength(40) tone?: string;
  @IsOptional() @IsIn(['facebook', 'instagram']) platform?: string;
}
class CreatePostDto {
  @IsArray() @ArrayMaxSize(2) @IsIn(['facebook', 'instagram'], { each: true }) platforms: string[];
  @IsOptional() @IsString() @MaxLength(5000) message?: string;
  @IsOptional() @IsString() @MaxLength(1000) @Matches(/^https?:\/\//) link?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) media_urls?: string[];
  @IsOptional() @IsString() scheduled_at?: string | null;
}
class DaysDto {
  @IsOptional() @Type(() => Number) @IsInt() days?: number;
}
class PostsQueryDto {
  @IsOptional() @IsIn(['facebook', 'instagram']) platform?: string;
}

@Controller('social')
@ApiTags('Social')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequiresFeature('social')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('overview') overview(@CurrentUser() user: AuthenticatedUser) { return this.social.overview(user); }
  @Patch('settings') settings(@CurrentUser() user: AuthenticatedUser, @Body() dto: SettingsDto) { return this.social.saveSettings(user, dto); }

  @Get('comments') comments(@CurrentUser() user: AuthenticatedUser, @Query() query: CommentsQueryDto) { return this.social.comments(user, query); }
  @Post('comments/sync') sync(@CurrentUser() user: AuthenticatedUser) { return this.social.sync(user); }
  @Post('comments/:id/reply') reply(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: MessageDto) { return this.social.reply(user, id, dto.message); }
  @Post('comments/:id/private-reply') privateReply(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: MessageDto) { return this.social.privateReply(user, id, dto.message); }
  @Post('comments/:id/hide') hide(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: HideDto) { return this.social.hide(user, id, dto.hidden); }
  @Post('comments/:id/like') like(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.social.like(user, id); }
  @Post('comments/:id/done') done(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: DoneDto) { return this.social.markDone(user, id, dto.done); }
  @Post('comments/:id/suggest') suggest(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.social.suggest(user, id); }
  @Delete('comments/:id') remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.social.remove(user, id); }

  @Get('posts') posts(@CurrentUser() user: AuthenticatedUser, @Query() query: PostsQueryDto) { return this.social.posts(user, query.platform ?? 'facebook'); }
  @Post('posts') create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePostDto) { return this.social.createPost(user, dto); }
  @Patch('posts/:postId') edit(@CurrentUser() user: AuthenticatedUser, @Param('postId') postId: string, @Body() dto: MessageDto) { return this.social.editPost(user, postId, dto.message); }
  @Delete('posts/:postId') deletePost(@CurrentUser() user: AuthenticatedUser, @Param('postId') postId: string) { return this.social.deletePost(user, postId); }
  @Post('media')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }))
  media(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string }) { return this.social.uploadMedia(user, file); }
  @Post('caption') caption(@CurrentUser() user: AuthenticatedUser, @Body() dto: CaptionDto) { return this.social.caption(user, dto); }
  @Get('schedules') schedules(@CurrentUser() user: AuthenticatedUser) { return this.social.schedules(user); }
  @Delete('schedules/:id') cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.social.cancelSchedule(user, id); }

  @Get('insights') insights(@CurrentUser() user: AuthenticatedUser, @Query() query: DaysDto) { return this.social.insights(user, query.days); }
}

@Module({ imports: [AuthModule, SalesBotModule], controllers: [SocialController], providers: [SocialService] })
export class SocialModule {}
