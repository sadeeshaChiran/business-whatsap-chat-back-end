import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Team handbook for the platform team (super admins only). The chapters are Markdown files in `docs/handbook/`
 * (NN-slug.md, sorted by name). They are served by the API – not bundled into the public web app – so internal
 * support and operations notes are only readable after a super-admin login. Never put secrets in these files.
 */
export interface HandbookChapter { slug: string; title: string; markdown: string }

const DIRS = [
  resolve(process.cwd(), 'docs/handbook'),
  resolve(__dirname, '../../docs/handbook'),
  resolve(__dirname, '../../../docs/handbook'),
];

let cache: { at: number; chapters: HandbookChapter[] } | null = null;

export function loadHandbook(): HandbookChapter[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.chapters;
  const dir = DIRS.find((d) => existsSync(d));
  const chapters = !dir ? [] : readdirSync(dir)
    .filter((f) => /^\d+-[a-z0-9-]+\.md$/.test(f))
    .sort()
    .map((file) => {
      const markdown = readFileSync(resolve(dir, file), 'utf8');
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? file;
      return { slug: file.replace(/^\d+-/, '').replace(/\.md$/, ''), title, markdown };
    });
  cache = { at: Date.now(), chapters };
  return chapters;
}
