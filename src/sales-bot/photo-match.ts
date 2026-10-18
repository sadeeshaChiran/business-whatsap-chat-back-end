import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { absoluteProductImage, readOwnProductImage } from '../products/product-images';
import { productImages, productOptions, toNumber, variantLabel } from './sales-bot-context.service';

/**
 * Customer photo → the right product of THIS shop.
 *
 * 1. Fingerprint: the customer re-sent one of our own photos (forwarded, screenshot of our post / ad, re-compressed,
 *    a little cropped) → the product is known for sure, no AI guess.
 * 2. Otherwise the AI describes the photo, we pick the closest products by words (name, category, description,
 *    photo notes, options) and the AI compares the customer photo with those products' REAL photos side by side.
 * 3. Only a clear match ("same item", 85+) counts as found. Close but not sure → the bot shows the 2-3 closest
 *    products with photos and asks which one. Nothing close → it says so and suggests the nearest item.
 */

export type PhotoMatchProduct = {
  product_id: number;
  name: string;
  price: number;
  variant: string | null;
  confidence: number;
  available: boolean;
  differences?: string;
};

export type PhotoMatch = {
  /** exact = our own photo · likely = AI: same item · unsure = close options · none = not in the shop · not_product = slip, selfie… */
  status: 'exact' | 'likely' | 'unsure' | 'none' | 'not_product';
  method: 'fingerprint' | 'ai';
  item: string;
  description: string;
  products: PhotoMatchProduct[];
};

export type PhotoMatchUsage = { input_tokens: number; output_tokens: number; calls: number; cost_usd: number; latency_ms: number };

type Hash = { p: string; d: string; c: string };
type Analysis = {
  is_product: boolean; item: string; colours: string[]; pattern: string; material: string; text_on_item: string;
  pieces: number; screenshot: boolean; search_words: string[]; description: string;
};

/** Thresholds for "this is our photo": shape bits that differ (of 64) and average colour difference (0-255). */
const SHAPE_MAX = 9;
const COLOUR_MAX = 30;
const SURE = 85;
const CLOSE = 60;

const bitsDiffer = (a: string, b: string) => {
  let x = BigInt(`0x${a || '0'}`) ^ BigInt(`0x${b || '0'}`);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
};
/** Mean of the 8 most different cells of the 8×8 colour grid (0-255) – same as colour_distance in the sales bot. */
export const colourDiff = (a: string, b: string) => {
  const x = Buffer.from(a || '', 'hex');
  const y = Buffer.from(b || '', 'hex');
  if (!x.length || x.length !== y.length || x.length % 3) return 255;
  const cells: number[] = [];
  for (let i = 0; i < x.length; i += 3) cells.push((Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2])) / 3);
  cells.sort((m, n) => n - m);
  const top = cells.slice(0, 8);
  return top.reduce((sum, v) => sum + v, 0) / top.length;
};

/** How far apart two photos are: shape (0-64) and colour (0-255). */
export function photoDistance(product: Hash[], customer: Hash[]): { shape: number; colour: number } {
  let best = { shape: 64, colour: 255 };
  for (const a of product) {
    for (const b of customer) {
      const shape = Math.max(bitsDiffer(a.p, b.p), bitsDiffer(a.d, b.d));
      if (shape > best.shape + 4) continue;
      const colour = colourDiff(a.c, b.c);
      if (shape < best.shape || (shape === best.shape && colour < best.colour)) best = { shape, colour };
    }
  }
  return best;
}

const STOP = new Set(['the', 'and', 'with', 'for', 'a', 'an', 'of', 'in', 'on', 'item', 'product', 'photo', 'image', 'colour', 'color', 'style', 'set']);
const words = (text: string) => String(text ?? '').toLowerCase().replace(/[^a-z0-9඀-෿஀-௿ ]+/g, ' ').split(/\s+/)
  .filter((w) => w.length > 1 && !STOP.has(w));

/** Word overlap between the customer photo description and a product (type words count more). */
export function wordScore(analysis: Pick<Analysis, 'item' | 'search_words' | 'colours' | 'pattern' | 'text_on_item'>, productText: string): number {
  const have = new Set(words(productText));
  const hit = (w: string) => have.has(w) || [...have].some((h) => (h.length > 3 && w.length > 3) && (h.startsWith(w) || w.startsWith(h)));
  let score = 0;
  for (const w of words(analysis.item)) if (hit(w)) score += 3;
  for (const w of new Set(analysis.search_words.flatMap(words))) if (hit(w)) score += 1;
  for (const w of words(`${analysis.colours.join(' ')} ${analysis.pattern}`)) if (hit(w)) score += 0.5;
  for (const w of words(analysis.text_on_item)) if (hit(w)) score += 2;
  return score;
}

@Injectable()
export class PhotoMatchService {
  private readonly logger = new Logger(PhotoMatchService.name);

  constructor(@InjectRepository(Product) private readonly productRepository: Repository<Product>) {}

  private base() {
    return String(process.env.SALES_BOT_URL ?? '').trim().replace(/\/+$/, '');
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 60000): Promise<T> {
    const response = await fetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Key': String(process.env.SALES_BOT_API_KEY ?? '') },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return (await response.json()) as T;
  }

  private async photoB64(url: string): Promise<string | null> {
    const own = readOwnProductImage(url);
    if (own) return own.buffer.toString('base64');
    const link = absoluteProductImage(url);
    if (!/^https?:\/\//i.test(link)) return null;
    const response = await fetch(link, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!response?.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length && buffer.length <= 8 * 1024 * 1024 ? buffer.toString('base64') : null;
  }

  /** Which option a photo belongs to ("Red / M"), from the option photos and the photo-per-option table. */
  private variantOf(product: Product, url: string): string | null {
    for (const option of productOptions(product)) {
      if (option.image_url && absoluteProductImage(option.image_url) === url) return variantLabel(option);
    }
    for (const [key, image] of Object.entries(product.variant_image_match?.images ?? {})) {
      if (image && absoluteProductImage(image) === url) return key;
    }
    return null;
  }

  private entry(product: Product, confidence: number, variant: string | null, differences?: string): PhotoMatchProduct {
    return {
      product_id: Number(product.id), name: product.name, price: toNumber(product.price), variant, confidence,
      available: product.is_available !== false, ...(differences ? { differences } : {}),
    };
  }

  async match(companyId: number, media: { mime_type: string; data_b64: string }): Promise<{ match: PhotoMatch; usage: PhotoMatchUsage[] } | null> {
    if (!this.base() || !media.mime_type.startsWith('image/')) return null;
    const usage: PhotoMatchUsage[] = [];
    const products = await this.productRepository.createQueryBuilder('p')
      .leftJoinAndSelect('p.category', 'category')
      .leftJoinAndSelect('p.variants', 'variants')
      .addSelect('p.image_hashes')
      .where('p.company_id = :companyId', { companyId })
      .andWhere('p.is_deleted = false')
      .andWhere('COALESCE(p.show_to_bot, true) = true')
      .getMany();
    const withPhotos = products.filter((product) => productImages(product).length > 0);

    // 1. our own photo (sure) – fingerprints only, no AI cost
    let customerHashes: Hash[] = [];
    if (withPhotos.some((product) => product.image_hashes?.length)) {
      const printed = await this.post<{ hashes: Hash[][] }>('/photos/fingerprint',
        { images: [{ image_b64: media.data_b64, mime_type: media.mime_type }], customer: true }).catch(() => null);
      customerHashes = printed?.hashes?.[0] ?? [];
    }
    const exact: Array<{ product: Product; url: string; shape: number; colour: number }> = [];
    for (const product of withPhotos) {
      for (const photo of product.image_hashes ?? []) {
        const distance = photoDistance(photo.hashes ?? [], customerHashes);
        if (distance.shape <= SHAPE_MAX && distance.colour <= COLOUR_MAX) exact.push({ product, url: photo.url, ...distance });
      }
    }
    if (exact.length) {
      exact.sort((a, b) => a.shape - b.shape || a.colour - b.colour);
      const top = exact[0];
      const sameScore = exact.filter((e) => e.shape <= top.shape + 1 && Number(e.product.id) !== Number(top.product.id));
      const toEntry = (e: (typeof exact)[number]) => this.entry(e.product, 100 - e.shape, this.variantOf(e.product, absoluteProductImage(e.url)));
      const found = { item: '', description: '' };
      if (!sameScore.length) {
        return { match: { status: 'exact', method: 'fingerprint', ...found, products: [toEntry(top)] }, usage };
      }
      // the same photo is used for two products (e.g. two sizes) – the customer has to say which
      const unique = [top, ...sameScore].filter((e, i, list) => list.findIndex((x) => x.product.id === e.product.id) === i).slice(0, 3);
      return { match: { status: 'unsure', method: 'fingerprint', ...found, products: unique.map(toEntry) }, usage };
    }

    // 2. not our photo: the AI looks at it
    const analyzed = await this.post<{ analysis: Analysis; hashes: Hash[]; usage: PhotoMatchUsage }>(
      '/photos/analyze', { image_b64: media.data_b64, mime_type: media.mime_type });
    if (analyzed.usage) usage.push(analyzed.usage);
    const analysis = analyzed.analysis;
    if (!customerHashes.length) customerHashes = analyzed.hashes ?? [];
    const base = { item: analysis.item, description: analysis.description };
    if (!analysis.is_product) return { match: { status: 'not_product', method: 'ai', ...base, products: [] }, usage };
    if (!withPhotos.length) return { match: { status: 'none', method: 'ai', ...base, products: [] }, usage };

    // 2. closest products by words (+ products whose photos look a bit alike), then the AI compares real photos
    const ranked = withPhotos.map((product) => {
      const text = [product.name, product.brand, product.brand, product.category?.name, String(product.description ?? '').slice(0, 300), product.image_notes,
        productOptions(product).map(variantLabel).join(' ')].join(' ');
      const near = Math.min(64, ...(product.image_hashes ?? []).map((photo) => photoDistance(photo.hashes ?? [], customerHashes).shape));
      return { product, score: wordScore(analysis, text) + (near <= 16 ? 4 : 0) };
    }).sort((a, b) => b.score - a.score);
    let candidates = ranked.filter((r) => r.score > 0).slice(0, 6);
    if (!candidates.length && withPhotos.length <= 8) candidates = ranked.slice(0, 8);
    if (!candidates.length) return { match: { status: 'none', method: 'ai', ...base, products: [] }, usage };

    const images: Array<{ key: string; image_b64: string; name: string; variant: string; notes: string }> = [];
    const byKey = new Map<string, { product: Product; variant: string | null }>();
    for (const { product } of candidates) {
      const urls = productImages(product);
      const optionUrls = urls.filter((url) => this.variantOf(product, url));
      const plain = urls.filter((url) => !this.variantOf(product, url));
      const pick = [...plain.slice(0, optionUrls.length ? 1 : 2), ...optionUrls.slice(0, 3)].slice(0, 3);
      for (const [index, url] of pick.entries()) {
        if (images.length >= 15) break;
        const b64 = await this.photoB64(url).catch(() => null);
        if (!b64) continue;
        const key = `${product.id}:${index}`;
        const variant = this.variantOf(product, url);
        byKey.set(key, { product, variant });
        images.push({ key, image_b64: b64, name: product.name, variant: variant ?? '', notes: String(product.image_notes ?? '').slice(0, 160) });
      }
    }
    if (!images.length) return { match: { status: 'none', method: 'ai', ...base, products: [] }, usage };
    const compared = await this.post<{ results: Array<{ key: string; same_item: boolean; similarity: number; differences: string }>; usage: PhotoMatchUsage | null }>(
      '/photos/compare', { image_b64: media.data_b64, mime_type: media.mime_type, candidates: images }, 90000);
    if (compared.usage) usage.push(compared.usage);

    // best photo per product
    const perProduct = new Map<number, { product: Product; variant: string | null; same: boolean; similarity: number; differences: string }>();
    for (const row of compared.results ?? []) {
      const hit = byKey.get(row.key);
      if (!hit) continue;
      const id = Number(hit.product.id);
      const current = perProduct.get(id);
      const better = !current || (row.same_item && !current.same) || (row.same_item === current.same && row.similarity > current.similarity);
      if (better) perProduct.set(id, { product: hit.product, variant: hit.variant, same: Boolean(row.same_item), similarity: Number(row.similarity) || 0, differences: row.differences });
    }
    const list = [...perProduct.values()].sort((a, b) => Number(b.same) - Number(a.same) || b.similarity - a.similarity);
    const first = list[0];
    const second = list[1];
    const clearWinner = first && first.same && first.similarity >= SURE
      && (!second || !second.same || second.similarity <= first.similarity - 10);
    if (clearWinner) {
      return { match: { status: 'likely', method: 'ai', ...base, products: [this.entry(first.product, first.similarity, first.variant)] }, usage };
    }
    const close = list.filter((row) => row.same || row.similarity >= CLOSE).slice(0, 3);
    if (close.length) {
      return { match: { status: 'unsure', method: 'ai', ...base, products: close.map((row) => this.entry(row.product, row.similarity, row.variant, row.differences)) }, usage };
    }
    const nearest = list.filter((row) => row.similarity >= 35).slice(0, 2);
    return { match: { status: 'none', method: 'ai', ...base, products: nearest.map((row) => this.entry(row.product, row.similarity, row.variant, row.differences)) }, usage };
  }
}

/** One line for the chat history / a reply to that photo: what the customer's photo was. */
export function photoMatchNote(match: PhotoMatch): string {
  const name = (p: PhotoMatchProduct) => `${p.name}${p.variant ? ` (${p.variant})` : ''} #${p.product_id}`;
  const looks = match.description || match.item;
  switch (match.status) {
    case 'exact': return `customer photo = our product ${name(match.products[0])} (our own photo)`;
    case 'likely': return `customer photo = our product ${name(match.products[0])} (${match.products[0].confidence}% sure)`;
    case 'unsure': return `customer photo (${looks}) – could be: ${match.products.map(name).join(' / ')} – not sure which`;
    case 'not_product': return `customer photo, not a product: ${looks}`;
    default: return `customer photo (${looks}) – not in our shop${match.products.length ? `; closest: ${match.products.map(name).join(' / ')}` : ''}`;
  }
}
