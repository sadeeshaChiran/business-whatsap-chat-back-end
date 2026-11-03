/**
 * Website AI help (public, no login) – NEW, self-contained module.
 *
 * Answers visitor questions about Agent Metra on the public website using ONLY the user guide in
 * `docs/user-guide/` (same chapters as the help center). It never reads company data, never calls the
 * sales bot, and touches no other module. Needs GEMINI_API_KEY; without it the endpoint replies 503 and
 * the website falls back to its built-in guide search.
 *
 *   POST /public/help/ask  { question: string, history?: string[] }  →  { answer, sources: [{ slug, title }] }
 */
import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Module,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

export class AskHelpDto {
  @IsString() @MinLength(2) @MaxLength(500) question!: string;
  /** earlier turns, oldest first, alternating visitor / assistant (kept short) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(1200, { each: true })
  history?: string[];
}

type Section = {
  slug: string;
  chapter: string;
  heading: string;
  text: string;
  words: Set<string>;
};

const DIRS = [
  resolve(process.cwd(), 'docs/user-guide'),
  resolve(__dirname, '../../docs/user-guide'),
  resolve(__dirname, '../../../docs/user-guide'),
];

const STOP = new Set(
  'the and for are you your can how what with this that does from have will when where which who into not but our its use using get about there them they then than also any all just only more most some such'.split(
    ' ',
  ),
);
const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );

let cache: { at: number; sections: Section[] } | null = null;

/** User guide split into "## " sections, cached for a minute. */
function loadSections(): Section[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.sections;
  const dir = DIRS.find((d) => existsSync(d));
  const sections: Section[] = [];
  if (dir) {
    for (const file of readdirSync(dir)
      .filter((f) => /^\d+-[a-z0-9-]+\.md$/.test(f))
      .sort()) {
      const brand = process.env.HELP_BRAND_NAME || 'Agent Metra';
      const md = readFileSync(resolve(dir, file), 'utf8').replace(
        /\{\{brand\}\}/g,
        brand,
      );
      const slug = file.replace(/^\d+-/, '').replace(/\.md$/, '');
      const chapter = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? slug;
      for (const part of md.split(/^(?=##\s)/m)) {
        const heading = /^##\s+(.+)$/m.exec(part)?.[1]?.trim() ?? chapter;
        const text = part.trim();
        if (text.length < 40) continue;
        sections.push({
          slug,
          chapter,
          heading,
          text,
          words: words(`${chapter} ${heading} ${text}`),
        });
      }
    }
  }
  cache = { at: Date.now(), sections };
  return sections;
}

/** The sections that best match the question (simple keyword overlap, headings count double). */
function pick(question: string, limit = 6, maxChars = 14_000): Section[] {
  const q = words(question);
  const scored = loadSections()
    .map((s) => {
      let score = 0;
      for (const w of q) {
        if (s.words.has(w)) score += 1;
        if (`${s.chapter} ${s.heading}`.toLowerCase().includes(w)) score += 2;
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const out: Section[] = [];
  let size = 0;
  for (const { s } of scored) {
    if (out.length >= limit || size + s.text.length > maxChars) break;
    out.push(s);
    size += s.text.length;
  }
  return out.length ? out : loadSections().slice(0, 3);
}

const SYSTEM = (
  brand: string,
) => `You are the help assistant on the public website of ${brand}, an AI sales and support platform for WhatsApp, Instagram and Messenger used by businesses in Sri Lanka.
Rules:
- Answer ONLY from the user guide excerpts provided. If the excerpts do not cover the question, say you are not sure and suggest contacting the team or opening the help center. Never invent prices, limits, features or dates.
- Prices and package limits change: for those, point to the Pricing page instead of quoting numbers.
- Reply in the visitor's language and style (English, Sinhala, Tamil or Singlish).
- Be short and practical: 2–6 sentences, or a few short steps. Plain text, no markdown headings.
- Only talk about ${brand}. Politely decline anything else.`;

@Controller('public/help')
@ApiTags('Public')
export class PublicHelpController {
  private readonly logger = new Logger('PublicHelp');

  @Post('ask')
  @Throttle({
    default: {
      limit: Number(process.env.HELP_AI_PER_MINUTE ?? 8),
      ttl: 60_000,
    },
  })
  async ask(@Body() dto: AskHelpDto) {
    const key = String(process.env.GEMINI_API_KEY ?? '').trim();
    if (!key || process.env.HELP_AI_ENABLED === 'false') {
      throw new HttpException(
        'AI help is not switched on.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const brand = process.env.HELP_BRAND_NAME || 'Agent Metra';
    const model = (
      process.env.HELP_AI_MODEL ||
      process.env.GEMINI_MODEL ||
      'gemini-2.5-flash'
    ).trim();
    const history = (dto.history ?? []).slice(-6);
    const sections = pick([...history.slice(-2), dto.question].join(' '));
    const context = sections
      .map((s) => `[${s.chapter} › ${s.heading}]\n${s.text}`)
      .join('\n\n---\n\n');

    const contents = [
      ...history.map((text, i) => ({
        role: i % 2 === 0 ? 'user' : 'model',
        parts: [{ text }],
      })),
      {
        role: 'user',
        parts: [
          {
            text: `User guide excerpts:\n\n${context}\n\n---\n\nVisitor question: ${dto.question}`,
          },
        ],
      },
    ];
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM(brand) }] },
            contents,
            generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const body = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const answer = (body.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      if (!answer) throw new Error('empty answer');
      const sources = [
        ...new Map(
          sections.map((s) => [s.slug, { slug: s.slug, title: s.chapter }]),
        ).values(),
      ].slice(0, 3);
      return { answer, sources };
    } catch (error) {
      this.logger.warn(
        `help answer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new HttpException(
        'AI help is busy right now. Please try again.',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}

@Module({ controllers: [PublicHelpController] })
export class PublicHelpModule {}
