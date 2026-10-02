/** Passes Meta page / Instagram webhook "changes" (comments, posts) to the Social module without importing it. */
type Handler = (body: unknown) => Promise<void>;
let handler: Handler | null = null;

export const SocialHook = {
  register(next: Handler) { handler = next; },
  capture(body: unknown) {
    if (!handler) return;
    void handler(body).catch((error) => console.warn('[social] webhook capture failed:', error));
  },
};
