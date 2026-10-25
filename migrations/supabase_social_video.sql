-- Social: videos, reels and stories (Oct 2026)
-- format: post (feed), reel or story. background: published by the server in the background (videos), with a notification when done.
ALTER TABLE social_post_schedule ADD COLUMN IF NOT EXISTS format VARCHAR(10) NOT NULL DEFAULT 'post';
ALTER TABLE social_post_schedule ADD COLUMN IF NOT EXISTS background BOOLEAN NOT NULL DEFAULT FALSE;
