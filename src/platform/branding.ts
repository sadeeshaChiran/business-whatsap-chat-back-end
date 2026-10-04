/** Platform branding endpoints (public read, super admin edit). Service: branding.service.ts */
import {
  Body, Controller, Delete, Get, NotFoundException, Patch, Post, Res, StreamableFile,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, IsUrl, Matches, MaxLength, ValidateIf } from 'class-validator';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { BrandingService, MAX_LOGO_BYTES } from './branding.service';
import { SuperAdminAuditInterceptor } from './audit.interceptor';
import { SuperAdminGuard } from './super-admin.guard';

const empty = (value: unknown) => value === '' || value === null || value === undefined;

export class UpdateBrandingDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(80) tagline?: string;
  @IsOptional() @IsString() @MaxLength(60) by_line?: string;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Colour must look like #4f46e5.' }) primary_color?: string;
  @IsOptional() @IsString() @MaxLength(120) company_name?: string;
  @IsOptional() @ValidateIf((o: UpdateBrandingDto) => !empty(o.support_email)) @IsEmail({}, { message: 'Support email is not a valid email address.' }) @MaxLength(120) support_email?: string;
  @IsOptional() @IsString() @MaxLength(30) @Matches(/^[0-9+()\s-]*$/, { message: 'Phone may contain only numbers, spaces and + ( ) -' }) support_phone?: string;
  @IsOptional() @IsString() @MaxLength(30) @Matches(/^[0-9+()\s-]*$/, { message: 'WhatsApp may contain only numbers, spaces and + ( ) -' }) whatsapp?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @ValidateIf((o: UpdateBrandingDto) => !empty(o.website)) @IsUrl({ require_protocol: true, protocols: ['http', 'https'] }, { message: 'Website must start with https://' }) @MaxLength(200) website?: string;
}

/** Public (no login): branding for the website, sign-in and app. */
@Controller('public/branding')
@ApiTags('Public')
@SkipThrottle()
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  get() {
    return this.branding.get();
  }

  @Get('logo')
  @RawResponse()
  async logo(@Res({ passthrough: true }) res: Response) {
    const logo = await this.branding.logo();
    if (!logo) throw new NotFoundException('No logo uploaded.');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // URL changes (?v=) when the logo changes
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(logo.buffer, { type: logo.mime, disposition: 'inline' });
  }
}

/** Super admin: edit branding and logo. */
@Controller('super-admin/branding')
@ApiTags('Super admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@UseInterceptors(SuperAdminAuditInterceptor)
export class SuperAdminBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  get() {
    return this.branding.get();
  }

  @Patch()
  update(@Body() dto: UpdateBrandingDto) {
    return this.branding.update(dto);
  }

  @Post('logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_LOGO_BYTES } }))
  uploadLogo(@UploadedFile() file: { buffer: Buffer; mimetype: string; size: number }) {
    return this.branding.setLogo(file);
  }

  @Delete('logo')
  removeLogo() {
    return this.branding.removeLogo();
  }
}
