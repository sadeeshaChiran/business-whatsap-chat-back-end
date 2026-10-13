/**
 * Lets the sign-up code start a new company's package (Free + optional welcome trial)
 * without importing the platform module (avoids a module cycle).
 */
type Handler = (companyId: number) => Promise<void>;
let handler: Handler | null = null;

export const SignupHook = {
  register(fn: Handler) { handler = fn; },
  async run(companyId: number) {
    if (!handler) return;
    try { await handler(companyId); } catch (error) { console.error('[signup] package start failed:', error); }
  },
};
