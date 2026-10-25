import { Body, Controller, Delete, Get, Module, Param, ParseIntPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
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
  @IsOptional() @IsIn(['post', 'reel', 'story']) format?: string;
  @IsOptional() @IsString() @MaxLength(5000) message?: string;
  @IsOptional() @IsString() @MaxLength(1000) @Matches(/^https?:\/\//) link?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) media_urls?: string[];
  @IsOptional() @IsString() scheduled_at?: string | null;
  @IsOptional() @IsBoolean() draft?: boolean;
}
class UpdatePostDto {
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['facebook', 'instagram'], { each: true }) platforms?: string[];
  @IsOptional() @IsIn(['post', 'reel', 'story']) format?: string;
  @IsOptional() @IsString() @MaxLength(5000) message?: string;
  @IsOptional() @IsString() @MaxLength(1000) @Matches(/^(https?:\/\/.*)?$/) link?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) media_urls?: string[];
  @IsOptional() @IsString() scheduled_at?: string | null;
  @IsOptional() @IsBoolean() draft?: boolean;
}
class SavedReplyDto {
  @IsIn(['reply', 'dm', 'hashtags']) kind: string;
  @IsString() @MinLength(1) @MaxLength(80) title: string;
  @IsString() @MinLength(1) @MaxLength(2000) text: string;
}
class DaysDto {
  @IsOptional() @Type(() => Number) @IsInt() days?: number;
}
class PostsQueryDto {
  @IsOptional() @IsIn(['facebook', 'instagram']) platform?: string;
  @IsOptional() @IsIn(['all', 'post', 'video', 'reel', 'story']) kind?: string;
}
class InsightsQueryDto {
  @IsOptional() @IsIn(['facebook', 'instagram']) platform?: string;
  @IsOptional() @IsIn(['post', 'video', 'reel', 'story']) kind?: string;
}

/** Uploads go to a temp folder on disk (videos can be large), then into chat media storage. */
const socialUploadDir = () => {
  const dir = join(process.env.CHAT_MEDIA_DIR?.trim() || join(process.cwd(), 'storage', 'chat-media'), '.incoming');
  try { mkdirSync(dir, { recursive: true }); return dir; } catch { return tmpdir(); }
};
const socialUploadMaxBytes = () => Math.max(10, Number(process.env.SOCIAL_VIDEO_MAX_MB ?? 200)) * 1024 * 1024;

@Controller('social')
@ApiTags('Social')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequiresFeature('social')
@AdminOnly()
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

  @Get('posts') posts(@CurrentUser() user: AuthenticatedUser, @Query() query: PostsQueryDto) { return this.social.posts(user, query.platform ?? 'facebook', query.kind ?? 'all'); }
  @Get('posts/:postId/insights') postInsights(@CurrentUser() user: AuthenticatedUser, @Param('postId') postId: string, @Query() query: InsightsQueryDto) {
    return this.social.postInsights(user, postId, query.platform ?? 'facebook', query.kind);
  }
  @Post('posts') create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePostDto) { return this.social.createPost(user, dto); }
  @Patch('posts/:postId') edit(@CurrentUser() user: AuthenticatedUser, @Param('postId') postId: string, @Body() dto: MessageDto) { return this.social.editPost(user, postId, dto.message); }
  @Delete('posts/:postId') deletePost(@CurrentUser() user: AuthenticatedUser, @Param('postId') postId: string) { return this.social.deletePost(user, postId); }
  @Post('media')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: (_req, _file, done) => done(null, socialUploadDir()) }), limits: { fileSize: socialUploadMaxBytes() } }))
  media(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file?: { path?: string; size?: number; buffer?: Buffer; mimetype: string; originalname: string }) { return this.social.uploadMedia(user, file); }
  @Post('caption') caption(@CurrentUser() user: AuthenticatedUser, @Body() dto: CaptionDto) { return this.social.caption(user, dto); }
  @Get('schedules') schedules(@CurrentUser() user: AuthenticatedUser) { return this.social.schedules(user); }
  @Patch('schedules/:id') updateSchedule(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePostDto) { return this.social.updateSchedule(user, id, dto); }
  @Post('schedules/:id/publish') publishSchedule(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.social.publishSchedule(user, id); }
  @Get('saved') saved(@CurrentUser() user: AuthenticatedUser) { return this.social.savedReplies(user); }
  @Post('saved') saveReply(@CurrentUser() user: AuthenticatedUser, @Body() dto: SavedReplyDto) { return this.social.saveReply(user, dto); }
  @Delete('saved/:id') deleteReply(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.social.deleteReply(user, id); }
  @Delete('schedules/:id') cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.social.cancelSchedule(user, id); }

  @Get('insights') insights(@CurrentUser() user: AuthenticatedUser, @Query() query: DaysDto) { return this.social.insights(user, query.days); }
}

@Module({ imports: [AuthModule, SalesBotModule], controllers: [SocialController], providers: [SocialService] })
export class SocialModule {}
