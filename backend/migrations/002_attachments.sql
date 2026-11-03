ALTER TABLE media_assets DROP CONSTRAINT media_assets_scope_check;
ALTER TABLE media_assets DROP CONSTRAINT media_assets_purpose_check;
ALTER TABLE media_assets ADD COLUMN guild_id uuid REFERENCES guilds(id), ADD COLUMN channel_id uuid REFERENCES channels(id);
ALTER TABLE media_assets ADD CONSTRAINT media_assets_scope_check CHECK(scope IN ('profile','channel','guild'));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purpose_check CHECK(purpose IN ('avatar','banner','attachment','guild_icon','guild_banner','role_icon','emoji','sticker','sound','notification_sound','group_icon'));
ALTER TABLE media_assets ADD CONSTRAINT media_assets_scope_shape CHECK((scope='profile' AND guild_id IS NULL AND channel_id IS NULL) OR (scope='channel' AND channel_id IS NOT NULL AND guild_id IS NULL) OR (scope='guild' AND guild_id IS NOT NULL AND channel_id IS NULL));
CREATE INDEX assets_channel ON media_assets(channel_id);
CREATE INDEX assets_guild ON media_assets(guild_id);
ALTER TABLE upload_sessions DROP CONSTRAINT upload_sessions_scope_check;
ALTER TABLE upload_sessions DROP CONSTRAINT upload_sessions_purpose_check;
ALTER TABLE upload_sessions ADD COLUMN channel_id uuid REFERENCES channels(id), ADD COLUMN guild_id uuid REFERENCES guilds(id), ADD COLUMN part_size_bytes bigint, ADD COLUMN client_nonce uuid, ADD COLUMN failure_reason varchar(200);
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_scope_check CHECK(scope IN ('profile','channel','guild'));
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_purpose_check CHECK(purpose IN ('avatar','banner','attachment','emoji','sticker','sound','guild_icon','guild_banner','role_icon','notification_sound','group_icon'));
CREATE UNIQUE INDEX upload_nonce ON upload_sessions(uploader_id,client_nonce) WHERE client_nonce IS NOT NULL;
CREATE TABLE upload_parts (
 upload_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
 part_number integer NOT NULL CHECK(part_number BETWEEN 1 AND 10000), etag text NOT NULL,
 size_bytes bigint NOT NULL CHECK(size_bytes>0), sha256 char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(upload_id,part_number)
);
CREATE TABLE message_attachments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 asset_id uuid NOT NULL REFERENCES media_assets(id),position smallint NOT NULL DEFAULT 0 CHECK(position>=0),
 description varchar(1000),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(message_id,asset_id),UNIQUE(message_id,position)
);
CREATE INDEX attachment_asset ON message_attachments(asset_id);
ALTER TABLE messages DROP CONSTRAINT messages_check1;
CREATE FUNCTION valid_message_body() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid uuid;
BEGIN
 IF TG_TABLE_NAME='messages' THEN mid:=NEW.id; ELSE mid:=OLD.message_id; END IF;
 IF EXISTS(SELECT 1 FROM messages WHERE id=mid AND deleted_at IS NULL AND length(trim(content))=0)
 AND NOT EXISTS(SELECT 1 FROM message_attachments WHERE message_id=mid) THEN
  RAISE EXCEPTION 'Empty message' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER message_has_body AFTER INSERT OR UPDATE ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION valid_message_body();
CREATE CONSTRAINT TRIGGER attachment_preserves_body AFTER DELETE OR UPDATE ON message_attachments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION valid_message_body();
