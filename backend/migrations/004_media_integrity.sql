ALTER TABLE guilds ADD FOREIGN KEY(icon_asset_id) REFERENCES media_assets(id),ADD FOREIGN KEY(banner_asset_id) REFERENCES media_assets(id);
ALTER TABLE roles ADD FOREIGN KEY(icon_asset_id) REFERENCES media_assets(id);
ALTER TABLE voice_participants ADD COLUMN auth_session_id uuid REFERENCES auth_sessions(id),ADD COLUMN connected_at timestamptz;
CREATE TABLE processed_webhooks(id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
UPDATE roles SET permissions=permissions | (1::bigint<<15) | (1::bigint<<16) | (1::bigint<<17) | (1::bigint<<18) | (1::bigint<<22) WHERE is_everyone;
ALTER TABLE channels ADD CONSTRAINT direct_pair_present CHECK(type<>'dm' OR (dm_user_low_id IS NOT NULL AND dm_user_high_id IS NOT NULL));
