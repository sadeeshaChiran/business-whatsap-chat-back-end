import { mergeMemory } from './sales-bot-engine.service';
import { askedPhotoOptions, choosePhotos, variantPhotoOptions, wantsAllPhotos } from './photo-choice';

const img = (name: string) => `https://shop.example/${name}.jpg`;
/** VORA-style tee: Colour / Size, one photo per colour (shared by its sizes), cover = the white photo. */
const tee = {
  id: 11, name: 'Basic Cotton Tee', price: 1490, has_variants: true, image_url: img('tee-white'), gallery: [img('tee-back')],
  variants: [{ variants: ['White', 'Black', 'Navy', 'Sky Blue'].flatMap((colour) => ['S', 'M', 'L'].map((size) => ({
    variant_name: 'Colour / Size', variant_value: `${colour} / ${size}`, price: 1490, image_url: img(`tee-${colour.toLowerCase().replace(' ', '-')}`),
  }))) }],
} as never;
/** a product without option photos */
const plain = { id: 12, name: 'Cotton Sarong', price: 1490, has_variants: false, image_url: img('sarong'), gallery: [img('sarong-2')], variants: [] } as never;

describe('photo choice', () => {
  it('finds the colour the customer named – English, Singlish, Sinhala', () => {
    expect(askedPhotoOptions(tee, 'white Basic Cotton Tee eka thiyenawada?')).toEqual(['white']);
    expect(askedPhotoOptions(tee, 'sudu eka balanna')).toEqual(['white']);
    expect(askedPhotoOptions(tee, 'කළු එක පෙන්නන්න')).toEqual(['black']);
    expect(askedPhotoOptions(tee, 'show black and navy')).toEqual(['black', 'navy']);
    expect(askedPhotoOptions(tee, 'the sky blue one')).toEqual(['sky blue']); // not also a plain "blue"
    expect(askedPhotoOptions(tee, 'M size thiyenawada')).toEqual([]); // sizes are not photo choices here
    expect(askedPhotoOptions(tee, 'show me t shirts')).toEqual([]);
  });

  it("the AI's variant_id gives its colour photo, not its size", () => {
    expect(variantPhotoOptions(tee, 5)).toEqual(['black']); // 5th option = Black / M
    expect(variantPhotoOptions(tee, null, 'Navy / L')).toEqual(['navy']);
  });

  it('normally ONE photo; a named colour → only that colour; all → every photo', () => {
    expect(choosePhotos(tee, [], false).map((p) => p.url)).toEqual([img('tee-white')]);
    expect(choosePhotos(tee, ['black'], false).map((p) => p.url)).toEqual([img('tee-black')]);
    expect(choosePhotos(tee, ['black', 'navy'], false).map((p) => p.url)).toEqual([img('tee-black'), img('tee-navy')]);
    expect(choosePhotos(tee, [], true).map((p) => p.url)).toEqual(
      [img('tee-white'), img('tee-back'), img('tee-black'), img('tee-navy'), img('tee-sky-blue')]);
    expect(choosePhotos(plain, [], false).map((p) => p.url)).toEqual([img('sarong')]);
    expect(choosePhotos(plain, ['white'], false).map((p) => p.url)).toEqual([img('sarong')]); // no colour photos → main photo
  });

  it('knows when the customer wants every photo', () => {
    for (const text of ['send all photos', 'other colours?', 'more pics please', 'okkoma paata balanna', 'anith colours thiyenawada', 'ඔක්කොම පාට පෙන්නන්න'])
      expect([text, wantsAllPhotos(text)]).toEqual([text, true]);
    for (const text of ['show the white one', 'photo ekak denna', 'price kiyada?', 'I want 2 shirts'])
      expect([text, wantsAllPhotos(text)]).toEqual([text, false]);
  });
});

describe('photo choice – a size never pulls in another colour', () => {
  // Black comes only in S, so its photo is labelled "Black / S"
  const shirt = {
    id: 21, name: 'Basic Tee', price: 1490, has_variants: true, image_url: img('red'), gallery: [],
    variants: [{ variants: [
      { variant_name: 'Colour / Size', variant_value: 'Red / S', price: 1490, image_url: img('red') },
      { variant_name: 'Colour / Size', variant_value: 'Blue / S', price: 1490, image_url: img('blue') },
      { variant_name: 'Colour / Size', variant_value: 'Blue / M', price: 1490, image_url: img('blue') },
      { variant_name: 'Colour / Size', variant_value: 'Black / S', price: 1690, image_url: img('black') },
    ] }],
  } as never;
  it('variant Blue / S → only the blue photo', () => {
    expect(variantPhotoOptions(shirt, 2)).toEqual(['blue']);
    expect(choosePhotos(shirt, variantPhotoOptions(shirt, 2), false).map((p) => p.url)).toEqual([img('blue')]);
  });
  it('"blue S size" → only blue', () => {
    expect(askedPhotoOptions(shirt, 'blue S size thiyenawada')).toEqual(['blue']);
  });
});

describe('chat memory', () => {
  it('adds new facts, keeps the newest when long, accepts an old-style full memory', () => {
    expect(mergeMemory('', 'Name Nimal.')).toBe('Name Nimal.');
    expect(mergeMemory('Name Nimal.', 'Wants size M, black.')).toBe('Name Nimal. Wants size M, black.');
    expect(mergeMemory('Name Nimal. Wants size M.', 'Name Nimal. Wants size M. Budget 5000.')).toBe('Name Nimal. Wants size M. Budget 5000.');
    expect(mergeMemory('Name Nimal.', 'Name Nimal.')).toBe('Name Nimal.');
    const long = mergeMemory('A'.repeat(300) + '. ' + 'B'.repeat(290) + '.', 'Newest fact.');
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long.endsWith('Newest fact.')).toBe(true);
  });
});
