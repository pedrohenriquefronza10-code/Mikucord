CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username varchar(32) NOT NULL CHECK(length(trim(username)) BETWEEN 2 AND 32),
 tag varchar(4) NOT NULL CHECK(tag ~ '^[0-9]{4}$' AND tag <> '0000'), password_hash text NOT NULL,
 avatar_asset_id uuid, banner_asset_id uuid, about_me varchar(1000) NOT NULL DEFAULT '',
 preferred_status text NOT NULL DEFAULT 'online' CHECK(preferred_status IN ('online','idle','dnd','invisible')),
 custom_status_text varchar(128) NOT NULL DEFAULT '', custom_status_emoji varchar(64), custom_status_expires_at timestamptz,
 accent_color varchar(7) NOT NULL DEFAULT '#9B7AEF' CHECK(accent_color ~ '^#[0-9A-Fa-f]{6}$'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz, deleted_at timestamptz
);
CREATE UNIQUE INDEX users_handle ON users(lower(username),tag);
CREATE TABLE auth_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), family_id uuid NOT NULL,
 refresh_token_hash char(64) NOT NULL UNIQUE, replaced_by_session_id uuid REFERENCES auth_sessions(id), user_agent varchar(512),
 created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revocation_reason text, CHECK(expires_at > created_at)
);
CREATE INDEX sessions_user ON auth_sessions(user_id,revoked_at);
CREATE INDEX sessions_family ON auth_sessions(family_id);
CREATE TABLE user_preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 theme_mode text NOT NULL DEFAULT 'dark' CHECK(theme_mode IN ('dark','light')),
 show_member_list boolean NOT NULL DEFAULT true,
 message_density text NOT NULL DEFAULT 'normal' CHECK(message_density IN ('compact','normal','comfortable')),
 chat_font_size smallint NOT NULL DEFAULT 16 CHECK(chat_font_size BETWEEN 12 AND 28),
 locale varchar(35) NOT NULL DEFAULT 'pt-BR', timezone text NOT NULL DEFAULT 'America/Sao_Paulo', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guilds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(100) NOT NULL CHECK(length(trim(name))>0), owner_id uuid NOT NULL REFERENCES users(id),
 icon_asset_id uuid, banner_asset_id uuid, description varchar(1000) NOT NULL DEFAULT '',
 tags text[] NOT NULL DEFAULT '{}', boost_enabled boolean NOT NULL DEFAULT false, boost_level smallint NOT NULL DEFAULT 0,
 visual_settings jsonb NOT NULL DEFAULT '{}', default_notification_level text NOT NULL DEFAULT 'mentions',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 CHECK((NOT boost_enabled AND boost_level=0) OR (boost_enabled AND boost_level BETWEEN 1 AND 3))
);
CREATE INDEX guilds_owner ON guilds(owner_id);
CREATE TABLE guild_members (
 guild_id uuid NOT NULL REFERENCES guilds(id), user_id uuid NOT NULL REFERENCES users(id), nickname varchar(32),
 joined_at timestamptz NOT NULL DEFAULT now(), timeout_until timestamptz, notification_level text NOT NULL DEFAULT 'inherit', PRIMARY KEY(guild_id,user_id)
);
CREATE INDEX members_user ON guild_members(user_id);
ALTER TABLE guilds ADD CONSTRAINT owner_is_member FOREIGN KEY(id,owner_id) REFERENCES guild_members(guild_id,user_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE roles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id uuid NOT NULL REFERENCES guilds(id), name varchar(100) NOT NULL,
 color varchar(7) CHECK(color ~ '^#[0-9A-Fa-f]{6}$'), icon_asset_id uuid, permissions bigint NOT NULL DEFAULT 0 CHECK(permissions>=0),
 position integer NOT NULL DEFAULT 0 CHECK(position>=0), is_everyone boolean NOT NULL DEFAULT false,
 hoist boolean NOT NULL DEFAULT false, mentionable boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(guild_id,id), CHECK((is_everyone AND position=0) OR (NOT is_everyone AND position>0))
);
CREATE UNIQUE INDEX roles_everyone ON roles(guild_id) WHERE is_everyone;
CREATE INDEX roles_position ON roles(guild_id,position);
CREATE TABLE guild_member_roles (
 guild_id uuid NOT NULL, user_id uuid NOT NULL, role_id uuid NOT NULL, assigned_by uuid REFERENCES users(id), assigned_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(guild_id,user_id,role_id), FOREIGN KEY(guild_id,user_id) REFERENCES guild_members(guild_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(guild_id,role_id) REFERENCES roles(guild_id,id) ON DELETE CASCADE
);
CREATE INDEX member_roles_role ON guild_member_roles(guild_id,role_id);
CREATE TABLE channels (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id uuid NOT NULL REFERENCES guilds(id), type text NOT NULL CHECK(type IN ('category','text')),
 name varchar(100) NOT NULL CHECK(length(trim(name))>0), topic varchar(1024) NOT NULL DEFAULT '', parent_id uuid,
 created_by uuid NOT NULL REFERENCES users(id), position integer NOT NULL DEFAULT 0 CHECK(position>=0),
 slowmode_seconds integer NOT NULL DEFAULT 0 CHECK(slowmode_seconds>=0), permissions_synced boolean NOT NULL DEFAULT true,
 archived_at timestamptz, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(guild_id,id), FOREIGN KEY(guild_id,parent_id) REFERENCES channels(guild_id,id), CHECK(parent_id IS DISTINCT FROM id), CHECK(type<>'category' OR parent_id IS NULL)
);
CREATE INDEX channels_order ON channels(guild_id,parent_id,position);
CREATE FUNCTION check_channel_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM channels WHERE id=NEW.parent_id AND guild_id=NEW.guild_id AND type='category' AND deleted_at IS NULL) THEN
  RAISE EXCEPTION 'Invalid category' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER valid_channel_parent BEFORE INSERT OR UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION check_channel_parent();
CREATE TABLE channel_role_overwrites (
 guild_id uuid NOT NULL, channel_id uuid NOT NULL, role_id uuid NOT NULL, allow bigint NOT NULL DEFAULT 0, deny bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(channel_id,role_id), FOREIGN KEY(guild_id,channel_id) REFERENCES channels(guild_id,id) ON DELETE CASCADE,
 FOREIGN KEY(guild_id,role_id) REFERENCES roles(guild_id,id) ON DELETE CASCADE, CHECK(allow>=0 AND deny>=0 AND (allow & deny)=0)
);
CREATE TABLE channel_member_overwrites (
 guild_id uuid NOT NULL, channel_id uuid NOT NULL, user_id uuid NOT NULL, allow bigint NOT NULL DEFAULT 0, deny bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(channel_id,user_id), FOREIGN KEY(guild_id,channel_id) REFERENCES channels(guild_id,id) ON DELETE CASCADE,
 FOREIGN KEY(guild_id,user_id) REFERENCES guild_members(guild_id,user_id) ON DELETE CASCADE, CHECK(allow>=0 AND deny>=0 AND (allow & deny)=0)
);
CREATE TABLE guild_invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id uuid NOT NULL REFERENCES guilds(id), created_by uuid NOT NULL REFERENCES users(id),
 code_hash char(64) NOT NULL UNIQUE, max_uses integer CHECK(max_uses>0), uses integer NOT NULL DEFAULT 0 CHECK(uses>=0),
 expires_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK(max_uses IS NULL OR uses<=max_uses)
);
CREATE INDEX invites_guild ON guild_invites(guild_id);
CREATE TABLE messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel_id uuid NOT NULL REFERENCES channels(id), author_id uuid NOT NULL REFERENCES users(id), client_nonce uuid NOT NULL,
 kind text NOT NULL DEFAULT 'user' CHECK(kind IN ('user','system')), content text NOT NULL CHECK(length(content)<=4000), version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 reply_to_message_id uuid, mentions_everyone boolean NOT NULL DEFAULT false, edited_at timestamptz, deleted_at timestamptz, deleted_by uuid REFERENCES users(id),
 pinned_at timestamptz, pinned_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(channel_id,id), UNIQUE(author_id,client_nonce), FOREIGN KEY(channel_id,reply_to_message_id) REFERENCES messages(channel_id,id),
 CHECK(reply_to_message_id IS DISTINCT FROM id), CHECK(deleted_at IS NOT NULL OR length(trim(content))>0), CHECK((pinned_at IS NULL)=(pinned_by IS NULL))
);
CREATE INDEX messages_history ON messages(channel_id,created_at DESC,id DESC);
CREATE INDEX messages_author ON messages(author_id,created_at DESC);
CREATE TABLE message_user_mentions (message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id),PRIMARY KEY(message_id,user_id));
CREATE INDEX mentions_user ON message_user_mentions(user_id,message_id);
CREATE TABLE message_role_mentions (message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,guild_id uuid NOT NULL,role_id uuid NOT NULL,PRIMARY KEY(message_id,role_id),FOREIGN KEY(guild_id,role_id) REFERENCES roles(guild_id,id));
CREATE TABLE channel_read_states (
 channel_id uuid NOT NULL REFERENCES channels(id),user_id uuid NOT NULL REFERENCES users(id),last_read_message_id uuid,last_read_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(channel_id,user_id),FOREIGN KEY(channel_id,last_read_message_id) REFERENCES messages(channel_id,id)
);
CREATE INDEX read_states_user ON channel_read_states(user_id);
CREATE TABLE storage_objects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sha256 char(64) NOT NULL UNIQUE,bucket text NOT NULL,object_key text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>=0),detected_mime text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','ready','quarantined','deleting')),created_at timestamptz NOT NULL DEFAULT now(),verified_at timestamptz,UNIQUE(bucket,object_key)
);
CREATE TABLE media_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),storage_object_id uuid NOT NULL REFERENCES storage_objects(id),owner_id uuid NOT NULL REFERENCES users(id),
 scope text NOT NULL CHECK(scope='profile'),purpose text NOT NULL CHECK(purpose IN ('avatar','banner')),original_filename text NOT NULL,declared_mime text,
 width integer CHECK(width>0),height integer CHECK(height>0),duration_ms bigint CHECK(duration_ms>0),created_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz
);
CREATE INDEX assets_owner ON media_assets(owner_id);
CREATE INDEX assets_blob ON media_assets(storage_object_id);
ALTER TABLE users ADD FOREIGN KEY(avatar_asset_id) REFERENCES media_assets(id);
ALTER TABLE users ADD FOREIGN KEY(banner_asset_id) REFERENCES media_assets(id);
CREATE TABLE upload_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),uploader_id uuid NOT NULL REFERENCES users(id),scope text NOT NULL DEFAULT 'profile' CHECK(scope='profile'),
 purpose text NOT NULL CHECK(purpose IN ('avatar','banner')),filename text NOT NULL,declared_mime text,expected_size_bytes bigint CHECK(expected_size_bytes>=0),
 received_size_bytes bigint NOT NULL DEFAULT 0 CHECK(received_size_bytes>=0),staging_object_key text NOT NULL UNIQUE,multipart_upload_id text,
 state text NOT NULL CHECK(state IN ('created','uploading','verifying','complete','failed','aborted')),result_asset_id uuid REFERENCES media_assets(id),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,completed_at timestamptz,
 CHECK(state<>'complete' OR (result_asset_id IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX uploads_state ON upload_sessions(uploader_id,state);
CREATE INDEX uploads_expiry ON upload_sessions(expires_at,state);
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_id uuid NOT NULL REFERENCES users(id),actor_id uuid REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('mention','role_mention','everyone_mention','system')),guild_id uuid REFERENCES guilds(id),channel_id uuid REFERENCES channels(id),message_id uuid REFERENCES messages(id),
 event_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,UNIQUE(recipient_id,event_key)
);
CREATE INDEX notifications_unread ON notifications(recipient_id,created_at DESC) WHERE read_at IS NULL;
CREATE TABLE audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),guild_id uuid NOT NULL REFERENCES guilds(id),actor_id uuid REFERENCES users(id),action text NOT NULL,target_type text NOT NULL,target_id uuid,
 reason varchar(1000),metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_guild ON audit_logs(guild_id,created_at DESC,id DESC);
CREATE TABLE outbox_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),aggregate_type text NOT NULL,aggregate_id uuid NOT NULL,aggregate_version bigint,event_type text NOT NULL,
 schema_version smallint NOT NULL DEFAULT 1,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),available_at timestamptz NOT NULL DEFAULT now(),
 claimed_until timestamptz,attempts integer NOT NULL DEFAULT 0,published_at timestamptz,last_error_code varchar(64)
);
CREATE INDEX outbox_pending ON outbox_events(available_at,created_at) WHERE published_at IS NULL;
