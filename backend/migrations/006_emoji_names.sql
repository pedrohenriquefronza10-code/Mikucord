-- Preserve typed emoji aliases when administrators rename catalog entries.
ALTER TABLE message_custom_emojis ADD COLUMN input_name text;
UPDATE message_custom_emojis m SET input_name=e.name FROM custom_emojis e WHERE e.id=m.emoji_id;
