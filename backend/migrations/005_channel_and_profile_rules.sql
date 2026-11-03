CREATE OR REPLACE FUNCTION check_channel_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.deleted_at IS NOT NULL THEN RETURN NEW;END IF;
 IF NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM channels WHERE id=NEW.parent_id AND guild_id=NEW.guild_id AND deleted_at IS NULL AND ((NEW.type='thread' AND type='forum') OR (NEW.type NOT IN ('thread','category') AND type='category'))) THEN RAISE EXCEPTION 'Invalid parent' USING ERRCODE='23514';END IF;
 IF NEW.type='thread' AND NEW.parent_id IS NULL THEN RAISE EXCEPTION 'Thread needs forum' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
