import { Body, Controller, Delete, Get, Module, Param, ParseIntPipe, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PusherService } from '../common/pusher.service';
import { WhatsappIntegrationModule } from '../integrations/whatsapp/whatsapp.module';
import { FlowSenderService } from './flow-sender.service';
import { FIELD_TYPES, FlowsService, STEP_TYPES, TRIGGERS, type FlowInput, type FormInput } from './flows.service';

class FieldDto {
  @IsOptional() @IsString() @MaxLength(40) id?: string;
  @IsString() @MaxLength(200) label: string;
  @IsIn(FIELD_TYPES as unknown as string[]) type: (typeof FIELD_TYPES)[number];
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) options?: string[];
  @IsOptional() @IsIn(['name', 'phone', 'email', 'address', '']) maps_to?: 'name' | 'phone' | 'email' | 'address' | '';
  @IsOptional() @IsString() @MaxLength(120) placeholder?: string;
}
class FormDto implements FormInput {
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) intro?: string;
  @IsArray() @ArrayMaxSize(25) @ValidateNested({ each: true }) @Type(() => FieldDto) fields: FieldDto[];
  @IsOptional() @IsString() @MaxLength(1000) thank_you?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) add_tags?: string[];
  @IsOptional() @IsString() set_stage?: string | null;
  @IsOptional() @IsBoolean() notify?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
class ButtonDto {
  @IsString() @MaxLength(20) label: string;
  @IsOptional() @IsInt() goto?: number | null;
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
}
class StepDto {
  @IsOptional() @IsString() @MaxLength(40) id: string;
  @IsIn(STEP_TYPES as unknown as string[]) type: (typeof STEP_TYPES)[number];
  @IsOptional() @IsString() @MaxLength(4000) text?: string;
  @IsOptional() @IsString() @MaxLength(300) media_key?: string;
  @IsOptional() @IsString() @MaxLength(2000) url?: string;
  @IsOptional() @IsString() @MaxLength(1000) caption?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ButtonDto) buttons?: ButtonDto[];
  @IsOptional() @IsString() @MaxLength(40) save_as?: string;
  @IsOptional() @IsInt() form_id?: number;
  @IsOptional() @IsIn(['chat', 'link']) form_mode?: 'chat' | 'link';
  @IsOptional() @IsInt() seconds?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsString() stage?: string;
  @IsOptional() @IsIn(['ai', 'human']) to?: 'ai' | 'human';
}
class TriggerConfigDto {
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) keywords?: string[];
  @IsOptional() @IsIn(['contains', 'exact', 'starts']) match?: 'contains' | 'exact' | 'starts';
  @IsOptional() @IsBoolean() any_ad?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) campaign_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) ad_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) post_ids?: string[];
  @IsOptional() @IsString() @MaxLength(500) comment_reply?: string;
  @IsOptional() @IsArray() @IsIn(['facebook', 'instagram'], { each: true }) comment_platforms?: Array<'facebook' | 'instagram'>;
  @IsOptional() @IsInt() gap_days?: number;
  @IsOptional() @IsBoolean() once_per_contact?: boolean;
}
class FlowDto implements FlowInput {
  @IsString() @MaxLength(255) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsIn(['active', 'paused', 'draft']) status?: 'active' | 'paused' | 'draft';
  @IsIn(TRIGGERS as unknown as string[]) trigger_type: (typeof TRIGGERS)[number];
  @IsOptional() @ValidateNested() @Type(() => TriggerConfigDto) trigger_config?: TriggerConfigDto;
  @IsOptional() @IsArray() @IsIn(['whatsapp', 'messenger', 'instagram'], { each: true }) channels?: Array<'whatsapp' | 'messenger' | 'instagram'>;
  @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => StepDto) steps: StepDto[];
  @IsOptional() @IsInt() priority?: number;
}
class StatusDto { @IsIn(['active', 'paused']) status: 'active' | 'paused'; }
class TestDto { @IsInt() conversation_id: number; }
class SubmitDto {
  @IsOptional() @IsString() @MaxLength(40) token?: string;
  @IsObject() answers: Record<string, unknown>;
}

@Controller('flows')
@ApiTags('Automation flows and forms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@AdminOnly()
export class FlowsController {
  constructor(private readonly flows: FlowsService) {}

  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.flows.flows(user); }
  @Post() create(@CurrentUser() user: AuthenticatedUser, @Body() dto: FlowDto) { return this.flows.createFlow(user, dto); }
  @Post('media')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } }))
  media(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string }) { return this.flows.uploadMedia(user, file); }

  @Get('forms') forms(@CurrentUser() user: AuthenticatedUser) { return this.flows.forms(user); }
  @Post('forms') createForm(@CurrentUser() user: AuthenticatedUser, @Body() dto: FormDto) { return this.flows.createForm(user, dto); }
  @Get('forms/:id') form(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.flows.form(user, id); }
  @Patch('forms/:id') updateForm(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: FormDto) { return this.flows.updateForm(user, id, dto); }
  @Delete('forms/:id') deleteForm(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.flows.deleteForm(user, id); }
  @Get('forms/:id/submissions') submissions(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.flows.submissions(user, id); }
  @Get('forms/:id/answers.xlsx')
  async answersXlsx(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const file = await this.flows.answersXlsx(user, id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.buffer);
  }

  @Get(':id') get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.flows.flow(user, id); }
  @Patch(':id') update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: FlowDto) { return this.flows.updateFlow(user, id, dto); }
  @Post(':id/status') status(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: StatusDto) { return this.flows.setFlowStatus(user, id, dto.status); }
  @Post(':id/test') test(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number, @Body() dto: TestDto) { return this.flows.testRun(user, id, dto.conversation_id); }
  @Get(':id/runs') runs(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.flows.runs(user, id); }
  @Delete(':id') remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseIntPipe) id: number) { return this.flows.deleteFlow(user, id); }
}

/** The form page customers open from a link (agentmetra.lk/f/<slug>) – no login. */
@Controller('public/forms')
@ApiTags('Public')
export class PublicFormsController {
  constructor(private readonly flows: FlowsService) {}

  @Get(':slug') get(@Param('slug') slug: string, @Query('t') token?: string) { return this.flows.publicForm(slug, token); }

  @Post(':slug/photo')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }))
  photo(@Param('slug') slug: string, @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string }) { return this.flows.publicUpload(slug, file); }

  @Post(':slug')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(@Param('slug') slug: string, @Body() dto: SubmitDto, @Req() req: Request) { return this.flows.publicSubmit(slug, dto, req.ip); }
}

@Module({
  imports: [AuthModule, WhatsappIntegrationModule],
  controllers: [FlowsController, PublicFormsController],
  providers: [FlowsService, FlowSenderService, PusherService],
})
export class FlowsModule {}
