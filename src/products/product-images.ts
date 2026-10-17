import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { memoryStorage } from 'multer';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { chatMediaRoot } from '../bot-admin/chat-media.store';

/**
 * Product photos are files on our server with a short, full public link, e.g.
 *   https://api.example.lk/v1/api/public/product-images/12-a8f3k2q9.jpg
 * (before: the whole picture was stored inside the product as a very long "data:image/…" text).
 * The same link works in the dashboard, for the AI bot, WhatsApp / Messenger / Instagram and the CSV import.
 */
export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const NAME = /^\d+-[a-z0-9]{8,16}\.(jpg|png|webp|gif)$/;

const dir = () => {
  const path = join(chatMediaRoot(), 'products');
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
};

/** The public address of the API (…/v1/api) – product links must be absolute so Meta and the bot can download them. */
export function publicApiBase(): string {
  return String(process.env.PUBLIC_API_BASE_URL ?? process.env.API_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
}
export const productImageUrl = (name: string) => `${publicApiBase() || '/v1/api'}/public/product-images/${name}`;

/** Recognises the real image type from the first bytes (a renamed .exe is not a photo). */
export function sniffImage(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return null;
}

export function saveProductImage(companyId: number, buffer: Buffer): string {
  if (!buffer.length || buffer.length > MAX_PRODUCT_IMAGE_BYTES) throw new BadRequestException('Each photo must be 5 MB or smaller.');
  const type = sniffImage(buffer);
  if (!type) throw new BadRequestException('Only JPG, PNG, WEBP or GIF photos can be added.');
  const name = `${Number(companyId) || 0}-${randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(8, '0').slice(0, 10)}.${TYPES[type]}`;
  writeFileSync(join(dir(), name), buffer);
  return productImageUrl(name);
}

/** "data:image/jpeg;base64,…" (old way, or pasted) → a stored file + its full link. Other values stay as they are. */
export function storeIfDataUrl(companyId: number, value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  const match = /^data:image\/[a-z+.-]+;base64,(.+)$/is.exec(text);
  if (!match) return text;
  return saveProductImage(companyId, Buffer.from(match[1], 'base64'));
}

/** Links of our own product photos that were saved without the public address → full links (for the bot / Meta). */
export function absoluteProductImage(url: string): string {
  const text = String(url ?? '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  const base = publicApiBase();
  const own = /\/public\/product-images\/([^/?#]+)$/.exec(text);
  return own && base ? `${base}/public/product-images/${own[1]}` : text;
}

/** Our own stored photo (by its link) straight from disk – no download over the internet needed. */
export function readOwnProductImage(url: string): { buffer: Buffer; mimetype: string } | null {
  const match = /\/public\/product-images\/([^/?#]+)$/.exec(String(url ?? '').trim());
  if (!match || !NAME.test(match[1])) return null;
  const path = join(dir(), match[1]);
  if (!existsSync(path)) return null;
  const ext = match[1].split('.').pop() as string;
  return { buffer: readFileSync(path), mimetype: Object.entries(TYPES).find(([, e]) => e === ext)?.[0] ?? 'image/jpeg' };
}

@Controller()
@ApiTags('Products')
export class ProductImagesController {
  /** Upload one photo → { url } (full public link). */
  @Post('products/images')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_PRODUCT_IMAGE_BYTES } }))
  upload(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file?: { buffer: Buffer }) {
    if (!file?.buffer) throw new BadRequestException('Choose a photo.');
    return { url: saveProductImage(Number(user.company_id), file.buffer) };
  }

  /** Public: product photos are shown to customers, WhatsApp and Meta download them. */
  @Get('public/product-images/:name')
  @SkipThrottle()
  serve(@Param('name') name: string, @Res() res: Response) {
    if (!NAME.test(name)) throw new NotFoundException();
    const path = join(dir(), name);
    if (!existsSync(path)) throw new NotFoundException();
    const ext = name.split('.').pop() as string;
    res.setHeader('Content-Type', Object.entries(TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(readFileSync(path));
  }
}
