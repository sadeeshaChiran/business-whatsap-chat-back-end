import { BotAdminService } from './bot-admin.service';

/** The comment card without a link: the banner takes the link from Meta's "You are responding to a user comment" line. */
describe('chat from a comment: banner link', () => {
  it('uses the link from Meta line when the card has none', async () => {
    const service: any = Object.create(BotAdminService.prototype);
    service.messageRepository = {
      query: async (sql: string) => {
        if (sql.includes('Reply to their comment')) return [{ id: 10, content: '💬 Reply to their comment: “ඔයාලා සයිස් දාන්නෙ නැනේ”', media_url: null, created_at: 'x', company_id: 16 }];
        if (sql.includes('responding to a user comment')) {
          return [{ content: 'You are responding to a user comment to a post on your Page. View comment. (https://facebook.com/615/posts/1222738/?comment_id=1090277)' }];
        }
        if (sql.includes('SELECT post_text FROM social_comment')) return [{ post_text: 'Baby frocks Rs 1,295' }];
        return [];
      },
    };
    const out = await service.commentOrigin(5, () => null);
    expect(out.comment).toBe('ඔයාලා සයිස් දාන්නෙ නැනේ');
    expect(out.comment_link).toBe('https://facebook.com/615/posts/1222738/?comment_id=1090277');
    expect(out.post_link).toBe('https://facebook.com/615/posts/1222738/');
    expect(out.post).toBe('Baby frocks Rs 1,295');
  });
});

describe('chat from a comment without our card', () => {
  it('Meta line alone still gives the banner (comment + links)', async () => {
    const service: any = Object.create(BotAdminService.prototype);
    service.messageRepository = {
      query: async (sql: string) => {
        if (sql.includes('Reply to their comment')) return [];
        if (sql.includes('responding to a user comment')) {
          return [{ id: 7, created_at: 'x', company_id: 16, content: 'You are responding to a user comment to a post on your Page. View comment.(https://facebook.com/reel/1631/?comment_id=2304)' }];
        }
        if (sql.includes('FROM social_comment')) return [{ message: '22', post_text: 'Quiz post', post_link: null }];
        return [];
      },
    };
    const out = await service.commentOrigin(5, () => null);
    expect(out).toMatchObject({ comment: '22', post: 'Quiz post', comment_link: 'https://facebook.com/reel/1631/?comment_id=2304', post_link: 'https://facebook.com/reel/1631/' });
  });
});

describe('chat from our auto private reply only', () => {
  it('the comment it answered gives the banner', async () => {
    const service: any = Object.create(BotAdminService.prototype);
    service.messageRepository = {
      query: async (sql: string) => {
        if (sql.includes("source = 'social-private-reply'")) {
          return [{ id: 3, created_at: 'x', message: 'plastic number eka?', post_text: 'Plastic storage box Rs 790', post_link: 'https://facebook.com/615/posts/99', comment_id: '99_555', platform: 'facebook' }];
        }
        return [];
      },
    };
    const out = await service.commentOrigin(5, () => null);
    expect(out).toMatchObject({ comment: 'plastic number eka?', post: 'Plastic storage box Rs 790',
      post_link: 'https://facebook.com/615/posts/99', comment_link: 'https://facebook.com/615/posts/99?comment_id=555' });
  });
});
