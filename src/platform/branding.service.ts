import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformSetting } from './entities/platform-setting.entity';

/**
 * Platform branding – set by the super admin, used everywhere: website, sign-in, the app for every
 * company, emails and platform invoices. Stored in platform_setting ('branding', 'branding_logo').
 */
export type Branding = {
  name: string;
  tagline: string;
  by_line: string;
  primary_color: string;
  company_name: string;
  support_email: string;
  support_phone: string;
  whatsapp: string;
  address: string;
  website: string;
  logo_url: string | null;
  updated_at: string | null;
};

export const DEFAULT_BRANDING: Branding = {
  name: 'Agent Metra',
  tagline: 'AI sales assistant',
  by_line: 'by Metrocoding',
  primary_color: '#4f46e5',
  company_name: 'Metrocoding (Pvt) Ltd',
  support_email: '',
  support_phone: '',
  whatsapp: '',
  address: '',
  website: '',
  logo_url: null,
  updated_at: null,
};

export const LOGO_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg',
};
export const MAX_LOGO_BYTES = 512 * 1024;

export type BrandingUpdate = Partial<Record<Exclude<keyof Branding, 'logo_url' | 'updated_at'>, string>>;

@Injectable()
export class BrandingService implements OnModuleInit {
  private static cache: { value: Branding; at: number } | null = null;
  private static instance: BrandingService | null = null;

  constructor(@InjectRepository(PlatformSetting) private readonly settings: Repository<PlatformSetting>) {
    BrandingService.instance = this;
  }

  async onModuleInit() {
    await this.get().catch(() => undefined); // warm the cache for emails / invoices
  }

  /** Branding with defaults – cached for 60 s (read on every public page load and email). */
  async get(): Promise<Branding> {
    const cached = BrandingService.cache;
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const [row, logo] = await Promise.all([
      this.settings.findOne({ where: { key: 'branding' } }).catch(() => null),
      this.settings.findOne({ where: { key: 'branding_logo' }, select: { key: true, updated_at: true } }).catch(() => null),
    ]);
    const stored = (row?.value ?? {}) as Partial<Branding>;
    const value: Branding = {
      ...DEFAULT_BRANDING,
      ...Object.fromEntries(Object.entries(stored).filter(([key, v]) => key in DEFAULT_BRANDING && typeof v === 'string')),
      logo_url: logo ? `/public/branding/logo?v=${new Date(logo.updated_at).getTime()}` : null,
      updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
    if (!value.name.trim()) value.name = DEFAULT_BRANDING.name;
    BrandingService.cache = { value, at: Date.now() };
    return value;
  }

  /** For emails and messages from places without dependency injection. */
  static current(): Branding {
    const cached = BrandingService.cache;
    if ((!cached || Date.now() - cached.at > 60_000) && BrandingService.instance) void BrandingService.instance.get().catch(() => undefined);
    return cached?.value ?? DEFAULT_BRANDING;
  }

  async update(dto: BrandingUpdate): Promise<Branding> {
    const current = await this.get();
    const next: Record<string, string> = {};
    for (const key of Object.keys(DEFAULT_BRANDING) as Array<keyof Branding>) {
      if (key === 'logo_url' || key === 'updated_at') continue;
      const incoming = (dto as Record<string, unknown>)[key];
      next[key] = typeof incoming === 'string' ? incoming.trim() : String(current[key] ?? '');
    }
    if (!next.name) throw new BadRequestException('Platform name is required.');
    next.primary_color = next.primary_color.toLowerCase();
    await this.settings.save({ key: 'branding', value: next });
    BrandingService.cache = null;
    return this.get();
  }

  async setLogo(file: { buffer: Buffer; mimetype: string; size: number } | undefined): Promise<Branding> {
    if (!file?.buffer?.length) throw new BadRequestException('Please choose an image.');
    const type = LOGO_TYPES[file.mimetype];
    if (!type) throw new BadRequestException('Logo must be PNG, JPG, WEBP or SVG.');
    if (file.buffer.length > MAX_LOGO_BYTES) throw new BadRequestException('Logo must be smaller than 512 KB.');
    if (type === 'svg' && /<script|on\w+\s*=|javascript:/i.test(file.buffer.toString('utf8'))) {
      throw new BadRequestException('This SVG contains scripts. Please export a plain SVG or use PNG.');
    }
    await this.settings.save({ key: 'branding_logo', value: { mime: file.mimetype, data: file.buffer.toString('base64') } });
    BrandingService.cache = null;
    return this.get();
  }

  async removeLogo(): Promise<Branding> {
    await this.settings.delete({ key: 'branding_logo' });
    BrandingService.cache = null;
    return this.get();
  }

  async logo(): Promise<{ buffer: Buffer; mime: string } | null> {
    const row = await this.settings.findOne({ where: { key: 'branding_logo' } });
    const value = row?.value as { mime?: string; data?: string } | undefined;
    if (!value?.data || !value.mime) return null;
    return { buffer: Buffer.from(value.data, 'base64'), mime: value.mime };
  }
}

