import { SocialService } from './social.service';

/** Each post is read once (text + photo) and every comment is answered by it; a post can switch AI replies off. */
describe('post read by the AI', () => {
  function service(rows: Record<string, any[]>) {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const dataSource: any = {
      query: async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        const key = Object.keys(rows).find((k) => sql.includes(k));
        return key ? rows[key] : [];
      },
    };
    const s: any = new (SocialService as any)(dataSource, {}, {});
    s.page = async () => ({ page_id: 'pg', page_access_token: 't' });
    return { s, calls };
  }

  it('100 comments at once: the post is read once and the result goes to every comment', async () => {
    const { s } = service({ 'INSERT INTO social_post_ai': [{ post_id: 'p1', auto_reply: true, kind: 'engagement', summary: 'Quiz', read_at: 'now' }] });
    s.withPost = async (_: number, c: any) => ({ ...c, post_text: 'How many people are in the room? Comment your answer' });
    let reads = 0;
    s.callBot = async (path: string) => { if (path === '/social/post-read') { reads += 1; await new Promise((r) => setTimeout(r, 20)); return { kind: 'engagement', summary: 'Quiz' }; } return {}; };
    const results = await Promise.all(Array.from({ length: 5 }, () => s.postAi(16, { post_id: 'p1', platform: 'facebook', post_text: '' })));
    expect(reads).toBe(1);
    expect(results.every((r: any) => r.kind === 'engagement')).toBe(true);
  });

  it('a post read before is not read again', async () => {
    const { s } = service({ 'SELECT * FROM social_post_ai': [{ post_id: 'p1', auto_reply: true, kind: 'product', summary: 'Doll oven set Rs 395', read_at: 'x' }] });
    s.callBot = async () => { throw new Error('should not read'); };
    expect((await s.postAi(16, { post_id: 'p1' })).kind).toBe('product');
  });

  it('the comment reply gets the post kind and summary', async () => {
    const { s } = service({
      'SELECT * FROM social_comment': [{ id: 1, post_id: 'p1', platform: 'facebook', post_text: 'x', message: '52', author_name: 'Nishu' }],
      'SELECT * FROM social_settings': [{ auto_reply: 'reply', auto_dm: true }],
      'SELECT * FROM social_post_ai': [{ post_id: 'p1', auto_reply: true, kind: 'engagement', summary: 'Quiz', read_at: 'x' }],
    });
    let body: any = null;
    s.callBot = async (_: string, b: any) => { body = b; return { reply: '', dm: '', intent: 'answer', hide: false }; };
    await s.suggestFor(16, 1);
    expect(body).toMatchObject({ post_kind: 'engagement', post_summary: 'Quiz', comment: '52' });
  });

  it('AI replies off for a post: the comment waits for the team', async () => {
    const { s } = service({
      'SELECT * FROM social_settings': [{ auto_reply: 'reply', auto_dm: true }],
      'SELECT * FROM social_comment': [{ id: 1, post_id: 'p1', status: 'open' }],
      'SELECT auto_reply FROM social_post_ai': [{ auto_reply: false }],
    });
    let asked = false;
    s.suggestFor = async () => { asked = true; return {}; };
    await s.autoHandle(16, 1);
    expect(asked).toBe(false);
  });
});
