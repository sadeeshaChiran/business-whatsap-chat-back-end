import { SocialService } from './social.service';

/** Webhook comments come without the post text: it is filled (other comments of the post / Meta), and the auto private
 * message chat gets the "Reply to their comment" card (inbox banner + the bot knows what the chat is about). */
describe('comment post text + card', () => {
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
    s.pusher = { trigger: () => undefined };
    return { s, calls };
  }

  it('takes the post text from another comment on the same post', async () => {
    const { s, calls } = service({ "post_text <> ''": [{ post_text: 'කාමරයේ කී දෙනෙක්ද? Comment your answer', post_link: 'https://fb.com/p/1' }] });
    const c = await s.withPost(16, { post_id: 'p1', post_text: '', platform: 'facebook', post_link: null });
    expect(c.post_text).toContain('Comment your answer');
    expect(c.post_link).toBe('https://fb.com/p/1');
    expect(calls.some((x) => x.sql.startsWith('UPDATE social_comment'))).toBe(true);
  });

  it('a post text already there is kept as it is', async () => {
    const { s, calls } = service({});
    const c = { post_id: 'p1', post_text: 'Doll oven set Rs 395' };
    expect(await s.withPost(16, c)).toBe(c);
    expect(calls.length).toBe(0);
  });

  it('the private message chat starts with the comment card', async () => {
    const { s, calls } = service({ 'SELECT id FROM bot_channel_user': [{ id: 5 }], 'SELECT id, status FROM bot_conversation': [{ id: 9, status: 'open' }] });
    await s.saveToInbox(16, 'messenger', 'page', 'cust', 'Anusha', 'Hello Anusha', 'm1', { comment: '52', post_text: 'Guess the number', post_link: 'https://fb.com/p/1' });
    const inserts = calls.filter((x) => x.sql.includes('INSERT INTO bot_message'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params[2]).toContain('💬 Reply to their comment: “52”');
    expect(inserts[0].params[2]).toContain('📝 Post: Guess the number');
    expect(inserts[1].params[3]).toBe('Hello Anusha');
  });
});
