import { BadRequestException, Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { chatMediaRoot } from './chat-media.store';
import { publicApiBase, sniffImage } from '../products/product-images';

/**
 * Files on an AI knowledge entry (a colour chart, a size guide, a price list PDF, a short video).
 * The bot sends them to the customer when the shop's knowledge says so: the context shows each file with a code
 * like [[file:12-1]], the bot writes the code in its reply, and the engine sends the file (the code never reaches
 * the customer). Stored on our server with a public link, like product photos.
 */
export type TrainingFileKind = 'image' | 'video' | 'document';
export type TrainingFile = { url: string; kind: TrainingFileKind; name: string; mime: string; size: number };

export const MAX_TRAINING_FILES = 5;
const LIMITS: Record<TrainingFileKind, number> = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, document: 16 * 1024 * 1024 };
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
};
const NAME = /^\d+-[a-z0-9]{8,16}\.(jpg|png|webp|gif|mp4|pdf)$/;

const dir = () => {
  const path = join(chatMediaRoot(), 'knowledge');
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
};

export const trainingFileUrl = (name: string) => `${publicApiBase() || '/v1/api'}/public/knowledge-files/${name}`;

/** The real type from the first bytes: photo (JPG / PNG / WEBP / GIF), MP4 video or PDF – nothing else. */
export function sniffTrainingFile(buffer: Buffer): { mime: string; kind: TrainingFileKind } | null {
  const image = sniffImage(buffer);
  if (image) return { mime: image, kind: 'image' };
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return { mime: 'application/pdf', kind: 'document' };
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return { mime: 'video/mp4', kind: 'video' };
  return null;
}

export function saveTrainingFile(companyId: number, file: { buffer: Buffer; originalname?: string }): TrainingFile {
  const buffer = file?.buffer;
  if (!buffer?.length) throw new BadRequestException('Choose a file.');
  const type = sniffTrainingFile(buffer);
  if (!type) throw new BadRequestException('Only photos (JPG, PNG, WEBP, GIF), MP4 videos and PDF files can be added.');
  if (buffer.length > LIMITS[type.kind]) {
    throw new BadRequestException(type.kind === 'image' ? 'A photo must be 5 MB or smaller.' : 'A video or PDF must be 16 MB or smaller (WhatsApp limit).');
  }
  const name = `${Number(companyId) || 0}-${randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(10, '0').slice(0, 12)}.${EXT[type.mime]}`;
  writeFileSync(join(dir(), name), buffer);
  const original = String(file.originalname ?? '').replace(/\.[^/.]+$/, '').replace(/[^\p{L}\p{N} ._()-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { url: trainingFileUrl(name), kind: type.kind, name: original || (type.kind === 'image' ? 'Photo' : type.kind === 'video' ? 'Video' : 'Document'), mime: type.mime, size: buffer.length };
}

/** The file name of one of OUR knowledge files from its link (null for any other link). */
export function ownTrainingFileName(url: string): string | null {
  const match = /\/public\/knowledge-files\/([^/?#]+)$/.exec(String(url ?? '').trim());
  return match && NAME.test(match[1]) ? match[1] : null;
}

/** A file from disk (no download over the internet). */
export function readTrainingFile(url: string): { buffer: Buffer; mimetype: string } | null {
  const name = ownTrainingFileName(url);
  if (!name) return null;
  const path = join(dir(), name);
  if (!existsSync(path)) return null;
  const ext = name.split('.').pop() as string;
  return { buffer: readFileSync(path), mimetype: Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream' };
}

/**
 * The files sent with a knowledge save: only our own stored links of THIS company, at most 5, cleaned.
 * Anything else (a link to another site, another shop's file) is dropped.
 */
export function cleanTrainingFiles(companyId: number, files: unknown): TrainingFile[] {
  if (!Array.isArray(files)) return [];
  const out: TrainingFile[] = [];
  for (const raw of files as Array<Partial<TrainingFile>>) {
    const name = ownTrainingFileName(String(raw?.url ?? ''));
    if (!name || !name.startsWith(`${Number(companyId)}-`)) continue;
    const ext = name.split('.').pop() as string;
    const mime = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    const kind: TrainingFileKind = mime.startsWith('image/') ? 'image' : mime === 'video/mp4' ? 'video' : 'document';
    if (out.some((f) => f.url.endsWith(name))) continue;
    out.push({ url: trainingFileUrl(name), kind, mime, name: String(raw?.name ?? '').trim().slice(0, 80) || kind, size: Math.max(0, Number(raw?.size) || 0) });
    if (out.length >= MAX_TRAINING_FILES) break;
  }
  return out;
}

/** The code the bot writes to send file n (1-based) of knowledge entry id. */
export const fileCode = (trainingId: number, n: number) => `[[file:${trainingId}-${n}]]`;
const CODE = /\[\[\s*file\s*:\s*(\d+)\s*-\s*(\d+)\s*\]\]/gi;

/** The lines added under a knowledge entry for the bot (what each file is and its code). */
export function fileLinesForBot(trainingId: number, files: TrainingFile[] | null | undefined): string {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '';
  const kind = (f: TrainingFile) => (f.kind === 'image' ? 'photo' : f.kind === 'video' ? 'video' : 'PDF');
  return `\nFILES of this entry – to send one to the customer, write its code anywhere in your reply (the system sends the file and removes the code; never write a code that is not listed): ${
    list.map((f, i) => `${fileCode(trainingId, i + 1)} = "${f.name}" (${kind(f)})`).join('; ')}`;
}

/** The file codes in a reply (each once, in order) and the reply without them. */
export function takeFileCodes(text: string | null | undefined): { text: string; codes: Array<{ trainingId: number; n: number }> } {
  const codes: Array<{ trainingId: number; n: number }> = [];
  const raw = String(text ?? '');
  CODE.lastIndex = 0;
  if (!CODE.test(raw)) return { text: text ?? '', codes };   // no code: the reply stays exactly as it was
  CODE.lastIndex = 0;
  const clean = raw.replace(CODE, (_all, id: string, n: string) => {
    const code = { trainingId: Number(id), n: Number(n) };
    if (!codes.some((c) => c.trainingId === code.trainingId && c.n === code.n)) codes.push(code);
    return '';
  }).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: clean, codes };
}

@Controller()
@ApiTags('AI knowledge files')
export class TrainingFilesPublicController {
  /** Public, like product photos: WhatsApp / Instagram download them. */
  @Get('public/knowledge-files/:name')
  @SkipThrottle()
  serve(@Param('name') name: string, @Res() res: Response) {
    if (!NAME.test(name)) throw new NotFoundException();
    const path = join(dir(), name);
    if (!existsSync(path)) throw new NotFoundException();
    const ext = name.split('.').pop() as string;
    res.setHeader('Content-Type', Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(readFileSync(path));
  }
}
