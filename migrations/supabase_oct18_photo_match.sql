-- Customer photo → product matching. Safe to run more than once.

-- perceptual fingerprints of every product photo: [{url, hashes: [{p, d, c}]}] (no AI needed to make them)
ALTER TABLE product ADD COLUMN IF NOT EXISTS image_hashes JSONB;
ALTER TABLE product ADD COLUMN IF NOT EXISTS image_hashes_src TEXT;

-- what a photo in the chat is: for a customer photo the match result ("matches #12 Cotton Romper Set"),
-- for a photo the bot sent the product name – used in the chat history and when someone replies to that photo
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS media_note TEXT;
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS media_match JSONB;
