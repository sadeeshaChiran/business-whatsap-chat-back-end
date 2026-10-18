import type { Product } from '../products/entities/product.entity';
import { photoOption, productImages, productOptions, variantLabel } from './sales-bot-context.service';

/**
 * Which photos of a product the bot sends:
 *  - normally ONE photo per product (the main photo) – a list of shirts = one photo of each shirt
 *  - the customer names an option ("white ABC", "sudu eka") → only THAT option's photo(s), never the first colour
 *  - the customer asks for all photos / all colours → every photo, each labelled with its option
 */

/** Singlish / Sinhala / Tamil colour words → English, so "sudu eka" finds the "White" photo. */
const COLOUR_WORDS: Record<string, string> = {
  sudu: 'white', සුදු: 'white', vellai: 'white',
  kalu: 'black', කළු: 'black', කලු: 'black', karuppu: 'black',
  rathu: 'red', ratu: 'red', රතු: 'red', sivappu: 'red',
  nil: 'blue', neela: 'blue', නිල්: 'blue', නිල: 'blue', neelam: 'blue',
  kola: 'green', කොළ: 'green', pachai: 'green',
  rosa: 'pink', රෝස: 'pink', pink: 'pink',
  kaha: 'yellow', කහ: 'yellow', manjal: 'yellow',
  dam: 'purple', දම්: 'purple',
  alu: 'grey', අළු: 'grey', gray: 'grey',
  dumburu: 'brown', දුඹුරු: 'brown',
  thambili: 'orange', තැඹිලි: 'orange',
  ran: 'gold', රන්: 'gold', ridee: 'silver', රිදී: 'silver',
};

const norm = (value: string) => value.toLowerCase().replace(/colour/g, 'color').replace(/gray/g, 'grey').trim();

/** Words of the customer's text, with colour words translated ("sudu" → also "white"). */
function textWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of norm(text).split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (!raw) continue;
    words.add(raw);
    if (COLOUR_WORDS[raw]) words.add(COLOUR_WORDS[raw]);
  }
  return words;
}

/** "Colour: White" / "White / M" → ["white", "m"] (the option values a photo shows). */
function labelParts(label: string): string[] {
  return label.split('/').map((part) => norm(part.includes(':') ? part.split(':').slice(1).join(':') : part)).filter(Boolean);
}

/** Every photo of the product with the option values it shows (empty for the main / gallery photos). */
export function photoParts(product: Product): Array<{ url: string; parts: string[] }> {
  return productImages(product).map((url) => ({ url, parts: labelParts(photoOption(product, url)?.label ?? '') }));
}

/**
 * Option values the customer named that have their own photo, e.g. "white abc eka" → ["white"].
 * Only values that appear on a photo count, so a size like "M" in a colour-photo shop is never a photo choice.
 */
export function askedPhotoOptions(product: Product, text: string): string[] {
  if (!text.trim()) return [];
  const words = textWords(text);
  const values = new Set(photoParts(product).flatMap((photo) => photo.parts));
  const found: string[] = [];
  for (const value of values) {
    const valueWords = value.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
    // "sky blue" needs both words; "blue" alone does not pick "sky blue" when a plain "blue" exists
    if (valueWords.length && valueWords.every((word) => words.has(word) || words.has(COLOUR_WORDS[word] ?? '\u0000'))) found.push(value);
  }
  // "sky blue" named → drop the plain "blue" it also matched (the longer, more exact name wins)
  return found.filter((value) => !found.some((other) => other !== value && ` ${other} `.includes(` ${value} `)));
}

/** The photo option values of one variant (by the AI's variant_id), e.g. variant "White / M" → ["white"]. */
export function variantPhotoOptions(product: Product, variantId?: number | null, variantName?: string | null): string[] {
  const option = variantId ? productOptions(product)[variantId - 1] : undefined;
  const label = option ? variantLabel(option) : String(variantName ?? '');
  if (!label.trim()) return [];
  const values = new Set(photoParts(product).flatMap((photo) => photo.parts));
  return labelParts(label).filter((part) => values.has(part));
}

/** The customer wants every photo / every colour ("all photos", "other colours", "okkoma paata", "anith colours"). */
export function wantsAllPhotos(text: string): boolean {
  const t = norm(text);
  return /\b(all|every|more|other|another|rest|different|remaining)\b[^.?!\n]{0,30}\b(photos?|pics?|pictures?|images?|colou?rs?|designs?|options?|variants?|types?|shades?)\b/.test(t)
    || /\b(photos?|pics?|pictures?|images?)\b[^.?!\n]{0,20}\b(all|every|more)\b/.test(t)
    || /\b(okkoma|okkom|hamadema|hama|anith|anit|wena|thawa|tawa)\b[^.?!\n]{0,20}\b(paata|pata|paat|colou?rs?|photos?|pics?|images?|design|designs)\b/.test(t)
    || /(ඔක්කොම|හැම|අනිත්|වෙන|තව)[^.?!\n]{0,20}(පාට|ෆොටෝ|පින්තූර|photo)/.test(text);
}

/**
 * The photos to send for one product, in order.
 * wanted = option values the customer asked for (empty = none); all = every photo.
 */
export function choosePhotos(product: Product, wanted: string[], all: boolean): Array<{ url: string; matched: boolean }> {
  const photos = photoParts(product);
  if (!photos.length) return [];
  const score = (parts: string[]) => wanted.filter((value) => parts.includes(value)).length;
  if (wanted.length) {
    const best = Math.max(...photos.map((photo) => score(photo.parts)));
    if (best > 0) {
      const own = photos.filter((photo) => score(photo.parts) === best).map((photo) => ({ url: photo.url, matched: true }));
      // several named colours ("white and black") → one photo of each; one colour → up to 2 photos of it
      if (all) return own.slice(0, 10);
      const perValue = wanted.length > 1
        ? wanted.flatMap((value) => photos.filter((photo) => photo.parts.includes(value)).slice(0, 1).map((photo) => ({ url: photo.url, matched: true })))
        : own.slice(0, 2);
      return perValue.filter((photo, i, list) => list.findIndex((p) => p.url === photo.url) === i);
    }
    // the asked option has no photo of its own → the main photo (its label does not claim that colour)
  }
  if (all) return photos.slice(0, 10).map((photo) => ({ url: photo.url, matched: false }));
  return [{ url: photos[0].url, matched: false }];
}
