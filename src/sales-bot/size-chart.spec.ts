import { asksForSizeChart, sizeChartPicks } from './size-chart';

describe('size charts', () => {
  it('knows when the customer asks for the size chart', () => {
    for (const text of ['size chart eka ewanna', 'size eka kohomada thoranne?', 'Size table ekak thiyenawada', 'mona size da thiyenne', 'සයිස් ගැන කියන්න', 'size chart please'])
      expect(asksForSizeChart(text)).toBe(true);
    for (const text of ['L size ekak ona', 'price kiyada', 'ok confirm', 'Red / M'])
      expect(asksForSizeChart(text)).toBe(false);
  });

  it('the products the AI named win (only ones with a chart)', () => {
    expect(sizeChartPicks({ aiIds: [5, 9], customerText: 'x', inChat: [7], withChart: new Set([5, 7]) })).toEqual([5]);
  });

  it('AI forgot, customer asked → the products in the chat', () => {
    expect(sizeChartPicks({ aiIds: [], customerText: 'size chart eka ewanna', inChat: [7, 7, 3, 5], withChart: new Set([5, 7]) })).toEqual([7, 5]);
  });

  it('nothing when the customer did not ask and the AI did not name one', () => {
    expect(sizeChartPicks({ aiIds: [], customerText: 'L size ekak ona', inChat: [7], withChart: new Set([7]) })).toEqual([]);
  });

  it('one product with a chart in the shop → that one', () => {
    expect(sizeChartPicks({ aiIds: [], customerText: 'size chart?', inChat: [], withChart: new Set([4]) })).toEqual([4]);
    expect(sizeChartPicks({ aiIds: [], customerText: 'size chart?', inChat: [], withChart: new Set([4, 6]) })).toEqual([]);
  });
});
