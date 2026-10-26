import { resolveLimits } from './package-limits';

/** The AI bot checks the package by channel name – every channel needs its switch (on unless a package turns it off). */
describe('package switches for the newer channels', () => {
  it.each(['app', 'telegram', 'tiktok'])('%s is on for a package that does not mention it, off when switched off', (key) => {
    expect(resolveLimits({ limits: {} }).features[key]).toBe(true);
    expect(resolveLimits({ limits: { [key]: false } }).features[key]).toBe(false);
  });
});
