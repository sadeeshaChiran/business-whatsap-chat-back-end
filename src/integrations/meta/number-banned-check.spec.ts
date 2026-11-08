import { presentChecks } from './meta.controller';

describe('connection check: a number Meta banned is not "Ready"', () => {
  it('shows the ban, with no PIN fix', () => {
    const [check] = presentChecks([{ key: 'registered', label: 'x', ok: false,
      detail: 'Status: BANNED. Meta has blocked this number – it cannot send or receive messages.' }], 'whatsapp');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('Blocked by Meta (BANNED)');
    expect(check.detail).not.toContain('PIN');
  });
  it('a working number stays Ready', () => {
    const [check] = presentChecks([{ key: 'registered', label: 'x', ok: true, detail: 'Status: CONNECTED' }], 'whatsapp');
    expect(check.detail).toBe('Ready');
  });
  it('a number that is not registered still asks for the PIN', () => {
    const [check] = presentChecks([{ key: 'registered', label: 'x', ok: false, detail: 'Meta says: ON_PREMISE / PENDING.', fix: 'whatsapp_register' }], 'whatsapp');
    expect(check.detail).toContain('PIN');
  });
});
