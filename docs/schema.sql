--
-- PostgreSQL database dump
--

\restrict LPT6ANAc2Wtcg7PVsJ5oRQ1bBv7S5sz5ebjQZB8FACn2NAzurOavd0TZjZr9wgf

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: check_channel_parent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_channel_parent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 IF NEW.deleted_at IS NOT NULL THEN RETURN NEW;END IF;
 IF NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM channels WHERE id=NEW.parent_id AND guild_id=NEW.guild_id AND deleted_at IS NULL AND ((NEW.type='thread' AND type='forum') OR (NEW.type NOT IN ('thread','category') AND type='category'))) THEN RAISE EXCEPTION 'Invalid parent' USING ERRCODE='23514';END IF;
 IF NEW.type='thread' AND NEW.parent_id IS NULL THEN RAISE EXCEPTION 'Thread needs forum' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;


--
-- Name: valid_message_body(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_message_body() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ DECLARE mid uuid; BEGIN
 IF TG_TABLE_NAME='messages' THEN mid:=NEW.id; ELSE mid:=OLD.message_id;END IF;
 IF EXISTS(SELECT 1 FROM messages WHERE id=mid AND deleted_at IS NULL AND length(trim(content))=0) AND NOT EXISTS(SELECT 1 FROM message_attachments WHERE message_id=mid) AND NOT EXISTS(SELECT 1 FROM message_stickers WHERE message_id=mid) THEN RAISE EXCEPTION 'Empty message' USING ERRCODE='23514';END IF;RETURN NULL;END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guild_id uuid NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id uuid,
    reason character varying(1000),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    family_id uuid NOT NULL,
    refresh_token_hash character(64) NOT NULL,
    replaced_by_session_id uuid,
    user_agent character varying(512),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revocation_reason text,
    CONSTRAINT auth_sessions_check CHECK ((expires_at > created_at))
);


--
-- Name: channel_member_overwrites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_member_overwrites (
    guild_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    allow bigint DEFAULT 0 NOT NULL,
    deny bigint DEFAULT 0 NOT NULL,
    CONSTRAINT channel_member_overwrites_check CHECK (((allow >= 0) AND (deny >= 0) AND ((allow & deny) = 0)))
);


--
-- Name: channel_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_members (
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    muted_until timestamp with time zone
);


--
-- Name: channel_read_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_read_states (
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    last_read_message_id uuid,
    last_read_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: channel_role_overwrites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_role_overwrites (
    guild_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    role_id uuid NOT NULL,
    allow bigint DEFAULT 0 NOT NULL,
    deny bigint DEFAULT 0 NOT NULL,
    CONSTRAINT channel_role_overwrites_check CHECK (((allow >= 0) AND (deny >= 0) AND ((allow & deny) = 0)))
);


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guild_id uuid,
    type text NOT NULL,
    name character varying(100) NOT NULL,
    topic character varying(1024) DEFAULT ''::character varying NOT NULL,
    parent_id uuid,
    created_by uuid NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    slowmode_seconds integer DEFAULT 0 NOT NULL,
    permissions_synced boolean DEFAULT true NOT NULL,
    archived_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dm_user_low_id uuid,
    dm_user_high_id uuid,
    group_owner_id uuid,
    icon_asset_id uuid,
    CONSTRAINT channel_scope CHECK ((((guild_id IS NOT NULL) AND (type <> ALL (ARRAY['dm'::text, 'group_dm'::text])) AND (dm_user_low_id IS NULL) AND (dm_user_high_id IS NULL) AND (group_owner_id IS NULL)) OR ((guild_id IS NULL) AND (parent_id IS NULL) AND (((type = 'dm'::text) AND (dm_user_low_id < dm_user_high_id) AND (group_owner_id IS NULL)) OR ((type = 'group_dm'::text) AND (dm_user_low_id IS NULL) AND (dm_user_high_id IS NULL) AND (group_owner_id IS NOT NULL)))))),
    CONSTRAINT channels_check CHECK ((parent_id IS DISTINCT FROM id)),
    CONSTRAINT channels_check1 CHECK (((type <> 'category'::text) OR (parent_id IS NULL))),
    CONSTRAINT channels_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT channels_position_check CHECK (("position" >= 0)),
    CONSTRAINT channels_slowmode_seconds_check CHECK ((slowmode_seconds >= 0)),
    CONSTRAINT channels_type_check CHECK ((type = ANY (ARRAY['category'::text, 'text'::text, 'voice'::text, 'video'::text, 'announcement'::text, 'forum'::text, 'thread'::text, 'dm'::text, 'group_dm'::text]))),
    CONSTRAINT direct_pair_present CHECK (((type <> 'dm'::text) OR ((dm_user_low_id IS NOT NULL) AND (dm_user_high_id IS NOT NULL))))
);


--
-- Name: custom_emojis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_emojis (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guild_id uuid NOT NULL,
    name character varying(32) NOT NULL,
    asset_id uuid NOT NULL,
    created_by uuid NOT NULL,
    animated boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT custom_emojis_name_check CHECK (((name)::text ~ '^[A-Za-z0-9_]{2,32}$'::text))
);


--
-- Name: custom_sound_effects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_sound_effects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guild_id uuid NOT NULL,
    name character varying(64) NOT NULL,
    asset_id uuid NOT NULL,
    created_by uuid NOT NULL,
    category character varying(64) DEFAULT 'Geral'::character varying NOT NULL,
    default_shortcut character varying(64),
    duration_ms integer NOT NULL,
    volume real DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT custom_sound_effects_duration_ms_check CHECK (((duration_ms >= 1) AND (duration_ms <= 10000))),
    CONSTRAINT custom_sound_effects_volume_check CHECK (((volume >= (0)::double precision) AND (volume <= (2)::double precision)))
);


--
-- Name: custom_stickers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_stickers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guild_id uuid NOT NULL,
    name character varying(64) NOT NULL,
    asset_id uuid NOT NULL,
    created_by uuid NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: friend_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friend_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sender_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    CONSTRAINT friend_requests_check CHECK ((sender_id <> recipient_id)),
    CONSTRAINT friend_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'cancelled'::text])))
);


--
-- Name: friendships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friendships (
    user_low_id uuid NOT NULL,
    user_high_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT friendships_check CHECK ((user_low_id < user_high_id))
);


--
-- Name: guild_bans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guild_bans (
    guild_id uuid NOT NULL,
    user_id uuid NOT NULL,
    banned_by uuid,
    reason character varying(1000),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: guild_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guild_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guild_id uuid NOT NULL,
    created_by uuid NOT NULL,
    code_hash character(64) NOT NULL,
    max_uses integer,
    uses integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guild_invites_check CHECK (((max_uses IS NULL) OR (uses <= max_uses))),
    CONSTRAINT guild_invites_max_uses_check CHECK ((max_uses > 0)),
    CONSTRAINT guild_invites_uses_check CHECK ((uses >= 0))
);


--
-- Name: guild_member_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guild_member_roles (
    guild_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: guild_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guild_members (
    guild_id uuid NOT NULL,
    user_id uuid NOT NULL,
    nickname character varying(32),
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    timeout_until timestamp with time zone,
    notification_level text DEFAULT 'inherit'::text NOT NULL
);


--
-- Name: guilds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guilds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    owner_id uuid NOT NULL,
    icon_asset_id uuid,
    banner_asset_id uuid,
    description character varying(1000) DEFAULT ''::character varying NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    boost_enabled boolean DEFAULT false NOT NULL,
    boost_level smallint DEFAULT 0 NOT NULL,
    visual_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    default_notification_level text DEFAULT 'mentions'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    theme_id uuid,
    CONSTRAINT guilds_check CHECK ((((NOT boost_enabled) AND (boost_level = 0)) OR (boost_enabled AND ((boost_level >= 1) AND (boost_level <= 3))))),
    CONSTRAINT guilds_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: media_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    storage_object_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    scope text NOT NULL,
    purpose text NOT NULL,
    original_filename text NOT NULL,
    declared_mime text,
    width integer,
    height integer,
    duration_ms bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    guild_id uuid,
    channel_id uuid,
    CONSTRAINT media_assets_duration_ms_check CHECK ((duration_ms > 0)),
    CONSTRAINT media_assets_height_check CHECK ((height > 0)),
    CONSTRAINT media_assets_purpose_check CHECK ((purpose = ANY (ARRAY['avatar'::text, 'banner'::text, 'attachment'::text, 'guild_icon'::text, 'guild_banner'::text, 'role_icon'::text, 'emoji'::text, 'sticker'::text, 'sound'::text, 'notification_sound'::text, 'group_icon'::text]))),
    CONSTRAINT media_assets_scope_check CHECK ((scope = ANY (ARRAY['profile'::text, 'channel'::text, 'guild'::text]))),
    CONSTRAINT media_assets_scope_shape CHECK ((((scope = 'profile'::text) AND (guild_id IS NULL) AND (channel_id IS NULL)) OR ((scope = 'channel'::text) AND (channel_id IS NOT NULL) AND (guild_id IS NULL)) OR ((scope = 'guild'::text) AND (guild_id IS NOT NULL) AND (channel_id IS NULL)))),
    CONSTRAINT media_assets_width_check CHECK ((width > 0))
);


--
-- Name: message_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    "position" smallint DEFAULT 0 NOT NULL,
    description character varying(1000),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_attachments_position_check CHECK (("position" >= 0))
);


--
-- Name: message_custom_emojis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_custom_emojis (
    message_id uuid NOT NULL,
    emoji_id uuid NOT NULL,
    input_name text
);


--
-- Name: message_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_reactions (
    message_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji_key text NOT NULL,
    unicode_emoji text,
    custom_emoji_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_reactions_check CHECK (((((unicode_emoji IS NOT NULL))::integer + ((custom_emoji_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT message_reactions_check1 CHECK ((((unicode_emoji IS NOT NULL) AND (emoji_key = ('u:'::text || unicode_emoji))) OR ((custom_emoji_id IS NOT NULL) AND (emoji_key = ('c:'::text || (custom_emoji_id)::text)))))
);


--
-- Name: message_role_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_role_mentions (
    message_id uuid NOT NULL,
    guild_id uuid NOT NULL,
    role_id uuid NOT NULL
);


--
-- Name: message_stickers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_stickers (
    message_id uuid NOT NULL,
    sticker_id uuid NOT NULL,
    "position" smallint DEFAULT 0 NOT NULL,
    CONSTRAINT message_stickers_position_check CHECK (("position" >= 0))
);


--
-- Name: message_user_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_user_mentions (
    message_id uuid NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    author_id uuid NOT NULL,
    client_nonce uuid NOT NULL,
    kind text DEFAULT 'user'::text NOT NULL,
    content text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    reply_to_message_id uuid,
    mentions_everyone boolean DEFAULT false NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    pinned_at timestamp with time zone,
    pinned_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_check CHECK ((reply_to_message_id IS DISTINCT FROM id)),
    CONSTRAINT messages_check2 CHECK (((pinned_at IS NULL) = (pinned_by IS NULL))),
    CONSTRAINT messages_content_check CHECK ((length(content) <= 4000)),
    CONSTRAINT messages_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'system'::text]))),
    CONSTRAINT messages_version_check CHECK ((version > 0))
);


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    sent_at timestamp with time zone,
    last_error_code character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_deliveries_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'suppressed'::text])))
);


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    user_id uuid NOT NULL,
    desktop_enabled boolean DEFAULT false NOT NULL,
    sound_enabled boolean DEFAULT true NOT NULL,
    direct_messages boolean DEFAULT true NOT NULL,
    mentions boolean DEFAULT true NOT NULL,
    everyone_mentions boolean DEFAULT true NOT NULL,
    quiet_hours_enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    weekday smallint NOT NULL,
    start_local time without time zone NOT NULL,
    end_local time without time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_schedules_check CHECK ((start_local < end_local)),
    CONSTRAINT notification_schedules_weekday_check CHECK (((weekday >= 1) AND (weekday <= 7)))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_id uuid NOT NULL,
    actor_id uuid,
    kind text NOT NULL,
    guild_id uuid,
    channel_id uuid,
    message_id uuid,
    event_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    friend_request_id uuid,
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['mention'::text, 'role_mention'::text, 'everyone_mention'::text, 'direct_message'::text, 'friend_request'::text, 'system'::text])))
);


--
-- Name: outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    aggregate_version bigint,
    event_type text NOT NULL,
    schema_version smallint DEFAULT 1 NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    published_at timestamp with time zone,
    last_error_code character varying(64)
);


--
-- Name: processed_webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.processed_webhooks (
    id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    auth_session_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_success_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guild_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    color character varying(7),
    icon_asset_id uuid,
    permissions bigint DEFAULT 0 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    is_everyone boolean DEFAULT false NOT NULL,
    hoist boolean DEFAULT false NOT NULL,
    mentionable boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roles_check CHECK (((is_everyone AND ("position" = 0)) OR ((NOT is_everyone) AND ("position" > 0)))),
    CONSTRAINT roles_color_check CHECK (((color)::text ~ '^#[0-9A-Fa-f]{6}$'::text)),
    CONSTRAINT roles_permissions_check CHECK ((permissions >= 0)),
    CONSTRAINT roles_position_check CHECK (("position" >= 0))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: soundboard_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.soundboard_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    voice_session_id uuid NOT NULL,
    sound_effect_id uuid NOT NULL,
    triggered_by uuid NOT NULL,
    client_nonce uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: storage_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sha256 character(64) NOT NULL,
    bucket text NOT NULL,
    object_key text NOT NULL,
    size_bytes bigint NOT NULL,
    detected_mime text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    CONSTRAINT storage_objects_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT storage_objects_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text, 'quarantined'::text, 'deleting'::text])))
);


--
-- Name: themes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.themes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    guild_id uuid,
    name character varying(64) NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    base_mode text NOT NULL,
    palette jsonb NOT NULL,
    schema_version smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT themes_base_mode_check CHECK ((base_mode = ANY (ARRAY['dark'::text, 'light'::text]))),
    CONSTRAINT themes_check CHECK ((((visibility = 'private'::text) AND (guild_id IS NULL)) OR ((visibility = 'guild'::text) AND (guild_id IS NOT NULL)))),
    CONSTRAINT themes_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'guild'::text])))
);


--
-- Name: upload_parts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_parts (
    upload_id uuid NOT NULL,
    part_number integer NOT NULL,
    etag text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_parts_part_number_check CHECK (((part_number >= 1) AND (part_number <= 10000))),
    CONSTRAINT upload_parts_size_bytes_check CHECK ((size_bytes > 0))
);


--
-- Name: upload_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    uploader_id uuid NOT NULL,
    scope text DEFAULT 'profile'::text NOT NULL,
    purpose text NOT NULL,
    filename text NOT NULL,
    declared_mime text,
    expected_size_bytes bigint,
    received_size_bytes bigint DEFAULT 0 NOT NULL,
    staging_object_key text NOT NULL,
    multipart_upload_id text,
    state text NOT NULL,
    result_asset_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    channel_id uuid,
    guild_id uuid,
    part_size_bytes bigint,
    client_nonce uuid,
    failure_reason character varying(200),
    CONSTRAINT upload_sessions_check CHECK (((state <> 'complete'::text) OR ((result_asset_id IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT upload_sessions_expected_size_bytes_check CHECK ((expected_size_bytes >= 0)),
    CONSTRAINT upload_sessions_purpose_check CHECK ((purpose = ANY (ARRAY['avatar'::text, 'banner'::text, 'attachment'::text, 'emoji'::text, 'sticker'::text, 'sound'::text, 'guild_icon'::text, 'guild_banner'::text, 'role_icon'::text, 'notification_sound'::text, 'group_icon'::text]))),
    CONSTRAINT upload_sessions_received_size_bytes_check CHECK ((received_size_bytes >= 0)),
    CONSTRAINT upload_sessions_scope_check CHECK ((scope = ANY (ARRAY['profile'::text, 'channel'::text, 'guild'::text]))),
    CONSTRAINT upload_sessions_state_check CHECK ((state = ANY (ARRAY['created'::text, 'uploading'::text, 'verifying'::text, 'complete'::text, 'failed'::text, 'aborted'::text])))
);


--
-- Name: user_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_blocks (
    blocker_id uuid NOT NULL,
    blocked_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_blocks_check CHECK ((blocker_id <> blocked_id))
);


--
-- Name: user_notification_sounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notification_sounds (
    user_id uuid NOT NULL,
    event text NOT NULL,
    asset_id uuid,
    enabled boolean DEFAULT true NOT NULL,
    volume real DEFAULT 1 NOT NULL,
    CONSTRAINT user_notification_sounds_event_check CHECK ((event = ANY (ARRAY['message'::text, 'call_join'::text, 'call_leave'::text]))),
    CONSTRAINT user_notification_sounds_volume_check CHECK (((volume >= (0)::double precision) AND (volume <= (1)::double precision)))
);


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id uuid NOT NULL,
    theme_mode text DEFAULT 'dark'::text NOT NULL,
    show_member_list boolean DEFAULT true NOT NULL,
    message_density text DEFAULT 'normal'::text NOT NULL,
    chat_font_size smallint DEFAULT 16 NOT NULL,
    locale character varying(35) DEFAULT 'pt-BR'::character varying NOT NULL,
    timezone text DEFAULT 'America/Sao_Paulo'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    theme_id uuid,
    CONSTRAINT user_preferences_chat_font_size_check CHECK (((chat_font_size >= 12) AND (chat_font_size <= 28))),
    CONSTRAINT user_preferences_message_density_check CHECK ((message_density = ANY (ARRAY['compact'::text, 'normal'::text, 'comfortable'::text]))),
    CONSTRAINT user_preferences_theme_mode_check CHECK ((theme_mode = ANY (ARRAY['dark'::text, 'light'::text, 'custom'::text])))
);


--
-- Name: user_soundboard_shortcuts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_soundboard_shortcuts (
    user_id uuid NOT NULL,
    sound_effect_id uuid NOT NULL,
    shortcut character varying(64) NOT NULL
);


--
-- Name: user_voice_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_voice_preferences (
    user_id uuid NOT NULL,
    target_user_id uuid NOT NULL,
    volume real DEFAULT 1 NOT NULL,
    muted_locally boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_voice_preferences_check CHECK ((user_id <> target_user_id)),
    CONSTRAINT user_voice_preferences_volume_check CHECK (((volume >= (0)::double precision) AND (volume <= (2)::double precision)))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying(32) NOT NULL,
    tag character varying(4) NOT NULL,
    password_hash text NOT NULL,
    avatar_asset_id uuid,
    banner_asset_id uuid,
    about_me character varying(1000) DEFAULT ''::character varying NOT NULL,
    preferred_status text DEFAULT 'online'::text NOT NULL,
    custom_status_text character varying(128) DEFAULT ''::character varying NOT NULL,
    custom_status_emoji character varying(64),
    custom_status_expires_at timestamp with time zone,
    accent_color character varying(7) DEFAULT '#9B7AEF'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT users_accent_color_check CHECK (((accent_color)::text ~ '^#[0-9A-Fa-f]{6}$'::text)),
    CONSTRAINT users_preferred_status_check CHECK ((preferred_status = ANY (ARRAY['online'::text, 'idle'::text, 'dnd'::text, 'invisible'::text]))),
    CONSTRAINT users_tag_check CHECK ((((tag)::text ~ '^[0-9]{4}$'::text) AND ((tag)::text <> '0000'::text))),
    CONSTRAINT users_username_check CHECK (((length(TRIM(BOTH FROM username)) >= 2) AND (length(TRIM(BOTH FROM username)) <= 32)))
);


--
-- Name: voice_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    voice_session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider_participant_identity text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    self_muted boolean DEFAULT false NOT NULL,
    self_deafened boolean DEFAULT false NOT NULL,
    server_muted boolean DEFAULT false NOT NULL,
    server_deafened boolean DEFAULT false NOT NULL,
    auth_session_id uuid,
    connected_at timestamp with time zone
);


--
-- Name: voice_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    provider_room_name text NOT NULL,
    started_by uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone
);


--
-- Name: voice_tracks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_tracks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    participant_id uuid NOT NULL,
    provider_track_sid text NOT NULL,
    source text NOT NULL,
    width integer,
    height integer,
    fps smallint,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT voice_tracks_fps_check CHECK (((fps >= 1) AND (fps <= 60))),
    CONSTRAINT voice_tracks_source_check CHECK ((source = ANY (ARRAY['microphone'::text, 'camera'::text, 'screen_video'::text, 'screen_audio'::text, 'soundboard'::text])))
);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_refresh_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_refresh_token_hash_key UNIQUE (refresh_token_hash);


--
-- Name: channel_member_overwrites channel_member_overwrites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_member_overwrites
    ADD CONSTRAINT channel_member_overwrites_pkey PRIMARY KEY (channel_id, user_id);


--
-- Name: channel_members channel_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_members
    ADD CONSTRAINT channel_members_pkey PRIMARY KEY (channel_id, user_id);


--
-- Name: channel_read_states channel_read_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_read_states
    ADD CONSTRAINT channel_read_states_pkey PRIMARY KEY (channel_id, user_id);


--
-- Name: channel_role_overwrites channel_role_overwrites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_role_overwrites
    ADD CONSTRAINT channel_role_overwrites_pkey PRIMARY KEY (channel_id, role_id);


--
-- Name: channels channels_guild_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_guild_id_id_key UNIQUE (guild_id, id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: custom_emojis custom_emojis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_emojis
    ADD CONSTRAINT custom_emojis_pkey PRIMARY KEY (id);


--
-- Name: custom_sound_effects custom_sound_effects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_sound_effects
    ADD CONSTRAINT custom_sound_effects_pkey PRIMARY KEY (id);


--
-- Name: custom_stickers custom_stickers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_stickers
    ADD CONSTRAINT custom_stickers_pkey PRIMARY KEY (id);


--
-- Name: friend_requests friend_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_pkey PRIMARY KEY (id);


--
-- Name: friendships friendships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_pkey PRIMARY KEY (user_low_id, user_high_id);


--
-- Name: guild_bans guild_bans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_bans
    ADD CONSTRAINT guild_bans_pkey PRIMARY KEY (guild_id, user_id);


--
-- Name: guild_invites guild_invites_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_invites
    ADD CONSTRAINT guild_invites_code_hash_key UNIQUE (code_hash);


--
-- Name: guild_invites guild_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_invites
    ADD CONSTRAINT guild_invites_pkey PRIMARY KEY (id);


--
-- Name: guild_member_roles guild_member_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_member_roles
    ADD CONSTRAINT guild_member_roles_pkey PRIMARY KEY (guild_id, user_id, role_id);


--
-- Name: guild_members guild_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_members
    ADD CONSTRAINT guild_members_pkey PRIMARY KEY (guild_id, user_id);


--
-- Name: guilds guilds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT guilds_pkey PRIMARY KEY (id);


--
-- Name: media_assets media_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);


--
-- Name: message_attachments message_attachments_message_id_asset_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_attachments
    ADD CONSTRAINT message_attachments_message_id_asset_id_key UNIQUE (message_id, asset_id);


--
-- Name: message_attachments message_attachments_message_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_attachments
    ADD CONSTRAINT message_attachments_message_id_position_key UNIQUE (message_id, "position");


--
-- Name: message_attachments message_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_attachments
    ADD CONSTRAINT message_attachments_pkey PRIMARY KEY (id);


--
-- Name: message_custom_emojis message_custom_emojis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_custom_emojis
    ADD CONSTRAINT message_custom_emojis_pkey PRIMARY KEY (message_id, emoji_id);


--
-- Name: message_reactions message_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (message_id, user_id, emoji_key);


--
-- Name: message_role_mentions message_role_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_role_mentions
    ADD CONSTRAINT message_role_mentions_pkey PRIMARY KEY (message_id, role_id);


--
-- Name: message_stickers message_stickers_message_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_stickers
    ADD CONSTRAINT message_stickers_message_id_position_key UNIQUE (message_id, "position");


--
-- Name: message_stickers message_stickers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_stickers
    ADD CONSTRAINT message_stickers_pkey PRIMARY KEY (message_id, sticker_id);


--
-- Name: message_user_mentions message_user_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_user_mentions
    ADD CONSTRAINT message_user_mentions_pkey PRIMARY KEY (message_id, user_id);


--
-- Name: messages messages_author_id_client_nonce_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_author_id_client_nonce_key UNIQUE (author_id, client_nonce);


--
-- Name: messages messages_channel_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_channel_id_id_key UNIQUE (channel_id, id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries notification_deliveries_notification_id_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_notification_id_subscription_id_key UNIQUE (notification_id, subscription_id);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: notification_schedules notification_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_schedules
    ADD CONSTRAINT notification_schedules_pkey PRIMARY KEY (id);


--
-- Name: notification_schedules notification_schedules_user_id_weekday_start_local_end_loca_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_schedules
    ADD CONSTRAINT notification_schedules_user_id_weekday_start_local_end_loca_key UNIQUE (user_id, weekday, start_local, end_local);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_recipient_id_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_recipient_id_event_key_key UNIQUE (recipient_id, event_key);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: processed_webhooks processed_webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processed_webhooks
    ADD CONSTRAINT processed_webhooks_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: roles roles_guild_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_guild_id_id_key UNIQUE (guild_id, id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: soundboard_events soundboard_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soundboard_events
    ADD CONSTRAINT soundboard_events_pkey PRIMARY KEY (id);


--
-- Name: soundboard_events soundboard_events_triggered_by_client_nonce_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soundboard_events
    ADD CONSTRAINT soundboard_events_triggered_by_client_nonce_key UNIQUE (triggered_by, client_nonce);


--
-- Name: storage_objects storage_objects_bucket_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_bucket_object_key_key UNIQUE (bucket, object_key);


--
-- Name: storage_objects storage_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_pkey PRIMARY KEY (id);


--
-- Name: storage_objects storage_objects_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_sha256_key UNIQUE (sha256);


--
-- Name: themes themes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_pkey PRIMARY KEY (id);


--
-- Name: upload_parts upload_parts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_parts
    ADD CONSTRAINT upload_parts_pkey PRIMARY KEY (upload_id, part_number);


--
-- Name: upload_sessions upload_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (id);


--
-- Name: upload_sessions upload_sessions_staging_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_staging_object_key_key UNIQUE (staging_object_key);


--
-- Name: user_blocks user_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_pkey PRIMARY KEY (blocker_id, blocked_id);


--
-- Name: user_notification_sounds user_notification_sounds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_sounds
    ADD CONSTRAINT user_notification_sounds_pkey PRIMARY KEY (user_id, event);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: user_soundboard_shortcuts user_soundboard_shortcuts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_soundboard_shortcuts
    ADD CONSTRAINT user_soundboard_shortcuts_pkey PRIMARY KEY (user_id, sound_effect_id);


--
-- Name: user_soundboard_shortcuts user_soundboard_shortcuts_user_id_shortcut_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_soundboard_shortcuts
    ADD CONSTRAINT user_soundboard_shortcuts_user_id_shortcut_key UNIQUE (user_id, shortcut);


--
-- Name: user_voice_preferences user_voice_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_voice_preferences
    ADD CONSTRAINT user_voice_preferences_pkey PRIMARY KEY (user_id, target_user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: voice_participants voice_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_participants
    ADD CONSTRAINT voice_participants_pkey PRIMARY KEY (id);


--
-- Name: voice_participants voice_participants_provider_participant_identity_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_participants
    ADD CONSTRAINT voice_participants_provider_participant_identity_key UNIQUE (provider_participant_identity);


--
-- Name: voice_sessions voice_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_pkey PRIMARY KEY (id);


--
-- Name: voice_sessions voice_sessions_provider_room_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_provider_room_name_key UNIQUE (provider_room_name);


--
-- Name: voice_tracks voice_tracks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_tracks
    ADD CONSTRAINT voice_tracks_pkey PRIMARY KEY (id);


--
-- Name: voice_tracks voice_tracks_provider_track_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_tracks
    ADD CONSTRAINT voice_tracks_provider_track_sid_key UNIQUE (provider_track_sid);


--
-- Name: assets_blob; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_blob ON public.media_assets USING btree (storage_object_id);


--
-- Name: assets_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_channel ON public.media_assets USING btree (channel_id);


--
-- Name: assets_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_guild ON public.media_assets USING btree (guild_id);


--
-- Name: assets_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_owner ON public.media_assets USING btree (owner_id);


--
-- Name: attachment_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachment_asset ON public.message_attachments USING btree (asset_id);


--
-- Name: audit_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_guild ON public.audit_logs USING btree (guild_id, created_at DESC, id DESC);


--
-- Name: channel_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_members_user ON public.channel_members USING btree (user_id);


--
-- Name: channels_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channels_order ON public.channels USING btree (guild_id, parent_id, "position");


--
-- Name: dm_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dm_pair ON public.channels USING btree (dm_user_low_id, dm_user_high_id) WHERE (type = 'dm'::text);


--
-- Name: emoji_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX emoji_name ON public.custom_emojis USING btree (guild_id, lower((name)::text)) WHERE (deleted_at IS NULL);


--
-- Name: friend_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX friend_pending ON public.friend_requests USING btree (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id)) WHERE (status = 'pending'::text);


--
-- Name: friendships_high; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friendships_high ON public.friendships USING btree (user_high_id);


--
-- Name: guilds_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guilds_owner ON public.guilds USING btree (owner_id);


--
-- Name: invites_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invites_guild ON public.guild_invites USING btree (guild_id);


--
-- Name: member_roles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_roles_role ON public.guild_member_roles USING btree (guild_id, role_id);


--
-- Name: members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX members_user ON public.guild_members USING btree (user_id);


--
-- Name: mentions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mentions_user ON public.message_user_mentions USING btree (user_id, message_id);


--
-- Name: messages_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_author ON public.messages USING btree (author_id, created_at DESC);


--
-- Name: messages_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_history ON public.messages USING btree (channel_id, created_at DESC, id DESC);


--
-- Name: messages_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_search ON public.messages USING gin (to_tsvector('simple'::regconfig, content)) WHERE (deleted_at IS NULL);


--
-- Name: notifications_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_unread ON public.notifications USING btree (recipient_id, created_at DESC) WHERE (read_at IS NULL);


--
-- Name: outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_pending ON public.outbox_events USING btree (available_at, created_at) WHERE (published_at IS NULL);


--
-- Name: push_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_pending ON public.notification_deliveries USING btree (state, next_attempt_at);


--
-- Name: reactions_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reactions_message ON public.message_reactions USING btree (message_id, emoji_key);


--
-- Name: read_states_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX read_states_user ON public.channel_read_states USING btree (user_id);


--
-- Name: roles_everyone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX roles_everyone ON public.roles USING btree (guild_id) WHERE is_everyone;


--
-- Name: roles_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX roles_position ON public.roles USING btree (guild_id, "position");


--
-- Name: sessions_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_family ON public.auth_sessions USING btree (family_id);


--
-- Name: sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user ON public.auth_sessions USING btree (user_id, revoked_at);


--
-- Name: sound_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sound_name ON public.custom_sound_effects USING btree (guild_id, lower((name)::text)) WHERE (deleted_at IS NULL);


--
-- Name: sticker_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sticker_name ON public.custom_stickers USING btree (guild_id, lower((name)::text)) WHERE (deleted_at IS NULL);


--
-- Name: sticker_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sticker_tags ON public.custom_stickers USING gin (tags);


--
-- Name: themes_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX themes_guild ON public.themes USING btree (guild_id, visibility);


--
-- Name: upload_nonce; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX upload_nonce ON public.upload_sessions USING btree (uploader_id, client_nonce) WHERE (client_nonce IS NOT NULL);


--
-- Name: uploads_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX uploads_expiry ON public.upload_sessions USING btree (expires_at, state);


--
-- Name: uploads_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX uploads_state ON public.upload_sessions USING btree (uploader_id, state);


--
-- Name: users_handle; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_handle ON public.users USING btree (lower((username)::text), tag);


--
-- Name: voice_active_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX voice_active_channel ON public.voice_sessions USING btree (channel_id) WHERE (ended_at IS NULL);


--
-- Name: voice_active_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX voice_active_user ON public.voice_participants USING btree (user_id) WHERE (left_at IS NULL);


--
-- Name: voice_track_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX voice_track_active ON public.voice_tracks USING btree (participant_id, source) WHERE (ended_at IS NULL);


--
-- Name: message_attachments attachment_preserves_body; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER attachment_preserves_body AFTER DELETE OR UPDATE ON public.message_attachments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.valid_message_body();


--
-- Name: messages message_has_body; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER message_has_body AFTER INSERT OR UPDATE ON public.messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.valid_message_body();


--
-- Name: message_stickers sticker_preserves_body; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER sticker_preserves_body AFTER DELETE OR UPDATE ON public.message_stickers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.valid_message_body();


--
-- Name: channels valid_channel_parent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER valid_channel_parent BEFORE INSERT OR UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION public.check_channel_parent();


--
-- Name: audit_logs audit_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: audit_logs audit_logs_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: auth_sessions auth_sessions_replaced_by_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_replaced_by_session_id_fkey FOREIGN KEY (replaced_by_session_id) REFERENCES public.auth_sessions(id);


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: channel_member_overwrites channel_member_overwrites_guild_id_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_member_overwrites
    ADD CONSTRAINT channel_member_overwrites_guild_id_channel_id_fkey FOREIGN KEY (guild_id, channel_id) REFERENCES public.channels(guild_id, id) ON DELETE CASCADE;


--
-- Name: channel_member_overwrites channel_member_overwrites_guild_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_member_overwrites
    ADD CONSTRAINT channel_member_overwrites_guild_id_user_id_fkey FOREIGN KEY (guild_id, user_id) REFERENCES public.guild_members(guild_id, user_id) ON DELETE CASCADE;


--
-- Name: channel_members channel_members_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_members
    ADD CONSTRAINT channel_members_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id);


--
-- Name: channel_members channel_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_members
    ADD CONSTRAINT channel_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: channel_read_states channel_read_states_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_read_states
    ADD CONSTRAINT channel_read_states_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id);


--
-- Name: channel_read_states channel_read_states_channel_id_last_read_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_read_states
    ADD CONSTRAINT channel_read_states_channel_id_last_read_message_id_fkey FOREIGN KEY (channel_id, last_read_message_id) REFERENCES public.messages(channel_id, id);


--
-- Name: channel_read_states channel_read_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_read_states
    ADD CONSTRAINT channel_read_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: channel_role_overwrites channel_role_overwrites_guild_id_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_role_overwrites
    ADD CONSTRAINT channel_role_overwrites_guild_id_channel_id_fkey FOREIGN KEY (guild_id, channel_id) REFERENCES public.channels(guild_id, id) ON DELETE CASCADE;


--
-- Name: channel_role_overwrites channel_role_overwrites_guild_id_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_role_overwrites
    ADD CONSTRAINT channel_role_overwrites_guild_id_role_id_fkey FOREIGN KEY (guild_id, role_id) REFERENCES public.roles(guild_id, id) ON DELETE CASCADE;


--
-- Name: channels channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: channels channels_dm_user_high_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_dm_user_high_id_fkey FOREIGN KEY (dm_user_high_id) REFERENCES public.users(id);


--
-- Name: channels channels_dm_user_low_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_dm_user_low_id_fkey FOREIGN KEY (dm_user_low_id) REFERENCES public.users(id);


--
-- Name: channels channels_group_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_group_owner_id_fkey FOREIGN KEY (group_owner_id) REFERENCES public.users(id);


--
-- Name: channels channels_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: channels channels_guild_id_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_guild_id_parent_id_fkey FOREIGN KEY (guild_id, parent_id) REFERENCES public.channels(guild_id, id);


--
-- Name: channels channels_icon_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_icon_asset_id_fkey FOREIGN KEY (icon_asset_id) REFERENCES public.media_assets(id);


--
-- Name: custom_emojis custom_emojis_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_emojis
    ADD CONSTRAINT custom_emojis_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id);


--
-- Name: custom_emojis custom_emojis_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_emojis
    ADD CONSTRAINT custom_emojis_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: custom_emojis custom_emojis_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_emojis
    ADD CONSTRAINT custom_emojis_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: custom_sound_effects custom_sound_effects_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_sound_effects
    ADD CONSTRAINT custom_sound_effects_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id);


--
-- Name: custom_sound_effects custom_sound_effects_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_sound_effects
    ADD CONSTRAINT custom_sound_effects_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: custom_sound_effects custom_sound_effects_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_sound_effects
    ADD CONSTRAINT custom_sound_effects_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: custom_stickers custom_stickers_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_stickers
    ADD CONSTRAINT custom_stickers_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id);


--
-- Name: custom_stickers custom_stickers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_stickers
    ADD CONSTRAINT custom_stickers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: custom_stickers custom_stickers_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_stickers
    ADD CONSTRAINT custom_stickers_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: friend_requests friend_requests_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id);


--
-- Name: friend_requests friend_requests_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id);


--
-- Name: friendships friendships_user_high_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_high_id_fkey FOREIGN KEY (user_high_id) REFERENCES public.users(id);


--
-- Name: friendships friendships_user_low_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_low_id_fkey FOREIGN KEY (user_low_id) REFERENCES public.users(id);


--
-- Name: guild_bans guild_bans_banned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_bans
    ADD CONSTRAINT guild_bans_banned_by_fkey FOREIGN KEY (banned_by) REFERENCES public.users(id);


--
-- Name: guild_bans guild_bans_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_bans
    ADD CONSTRAINT guild_bans_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: guild_bans guild_bans_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_bans
    ADD CONSTRAINT guild_bans_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: guild_invites guild_invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_invites
    ADD CONSTRAINT guild_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: guild_invites guild_invites_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_invites
    ADD CONSTRAINT guild_invites_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: guild_member_roles guild_member_roles_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_member_roles
    ADD CONSTRAINT guild_member_roles_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id);


--
-- Name: guild_member_roles guild_member_roles_guild_id_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_member_roles
    ADD CONSTRAINT guild_member_roles_guild_id_role_id_fkey FOREIGN KEY (guild_id, role_id) REFERENCES public.roles(guild_id, id) ON DELETE CASCADE;


--
-- Name: guild_member_roles guild_member_roles_guild_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_member_roles
    ADD CONSTRAINT guild_member_roles_guild_id_user_id_fkey FOREIGN KEY (guild_id, user_id) REFERENCES public.guild_members(guild_id, user_id) ON DELETE CASCADE;


--
-- Name: guild_members guild_members_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_members
    ADD CONSTRAINT guild_members_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: guild_members guild_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_members
    ADD CONSTRAINT guild_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: guilds guilds_banner_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT guilds_banner_asset_id_fkey FOREIGN KEY (banner_asset_id) REFERENCES public.media_assets(id);


--
-- Name: guilds guilds_icon_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT guilds_icon_asset_id_fkey FOREIGN KEY (icon_asset_id) REFERENCES public.media_assets(id);


--
-- Name: guilds guilds_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT guilds_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: guilds guilds_theme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT guilds_theme_id_fkey FOREIGN KEY (theme_id) REFERENCES public.themes(id);


--
-- Name: media_assets media_assets_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id);


--
-- Name: media_assets media_assets_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: media_assets media_assets_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: media_assets media_assets_storage_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_storage_object_id_fkey FOREIGN KEY (storage_object_id) REFERENCES public.storage_objects(id);


--
-- Name: message_attachments message_attachments_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_attachments
    ADD CONSTRAINT message_attachments_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id);


--
-- Name: message_attachments message_attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_attachments
    ADD CONSTRAINT message_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_custom_emojis message_custom_emojis_emoji_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_custom_emojis
    ADD CONSTRAINT message_custom_emojis_emoji_id_fkey FOREIGN KEY (emoji_id) REFERENCES public.custom_emojis(id);


--
-- Name: message_custom_emojis message_custom_emojis_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_custom_emojis
    ADD CONSTRAINT message_custom_emojis_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_reactions message_reactions_custom_emoji_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_custom_emoji_id_fkey FOREIGN KEY (custom_emoji_id) REFERENCES public.custom_emojis(id);


--
-- Name: message_reactions message_reactions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_reactions message_reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: message_role_mentions message_role_mentions_guild_id_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_role_mentions
    ADD CONSTRAINT message_role_mentions_guild_id_role_id_fkey FOREIGN KEY (guild_id, role_id) REFERENCES public.roles(guild_id, id);


--
-- Name: message_role_mentions message_role_mentions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_role_mentions
    ADD CONSTRAINT message_role_mentions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_stickers message_stickers_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_stickers
    ADD CONSTRAINT message_stickers_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_stickers message_stickers_sticker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_stickers
    ADD CONSTRAINT message_stickers_sticker_id_fkey FOREIGN KEY (sticker_id) REFERENCES public.custom_stickers(id);


--
-- Name: message_user_mentions message_user_mentions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_user_mentions
    ADD CONSTRAINT message_user_mentions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_user_mentions message_user_mentions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_user_mentions
    ADD CONSTRAINT message_user_mentions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: messages messages_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: messages messages_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id);


--
-- Name: messages messages_channel_id_reply_to_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_channel_id_reply_to_message_id_fkey FOREIGN KEY (channel_id, reply_to_message_id) REFERENCES public.messages(channel_id, id);


--
-- Name: messages messages_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id);


--
-- Name: messages messages_pinned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pinned_by_fkey FOREIGN KEY (pinned_by) REFERENCES public.users(id);


--
-- Name: notification_deliveries notification_deliveries_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;


--
-- Name: notification_deliveries notification_deliveries_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.push_subscriptions(id);


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: notification_schedules notification_schedules_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_schedules
    ADD CONSTRAINT notification_schedules_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: notifications notifications_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: notifications notifications_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id);


--
-- Name: notifications notifications_friend_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_friend_request_id_fkey FOREIGN KEY (friend_request_id) REFERENCES public.friend_requests(id);


--
-- Name: notifications notifications_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: notifications notifications_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id);


--
-- Name: notifications notifications_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id);


--
-- Name: guilds owner_is_member; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT owner_is_member FOREIGN KEY (id, owner_id) REFERENCES public.guild_members(guild_id, user_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: push_subscriptions push_subscriptions_auth_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES public.auth_sessions(id);


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: roles roles_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: roles roles_icon_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_icon_asset_id_fkey FOREIGN KEY (icon_asset_id) REFERENCES public.media_assets(id);


--
-- Name: soundboard_events soundboard_events_sound_effect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soundboard_events
    ADD CONSTRAINT soundboard_events_sound_effect_id_fkey FOREIGN KEY (sound_effect_id) REFERENCES public.custom_sound_effects(id);


--
-- Name: soundboard_events soundboard_events_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soundboard_events
    ADD CONSTRAINT soundboard_events_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id);


--
-- Name: soundboard_events soundboard_events_voice_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soundboard_events
    ADD CONSTRAINT soundboard_events_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id);


--
-- Name: themes themes_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: themes themes_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: upload_parts upload_parts_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_parts
    ADD CONSTRAINT upload_parts_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.upload_sessions(id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id);


--
-- Name: upload_sessions upload_sessions_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id);


--
-- Name: upload_sessions upload_sessions_result_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_result_asset_id_fkey FOREIGN KEY (result_asset_id) REFERENCES public.media_assets(id);


--
-- Name: upload_sessions upload_sessions_uploader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_uploader_id_fkey FOREIGN KEY (uploader_id) REFERENCES public.users(id);


--
-- Name: user_blocks user_blocks_blocked_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES public.users(id);


--
-- Name: user_blocks user_blocks_blocker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES public.users(id);


--
-- Name: user_notification_sounds user_notification_sounds_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_sounds
    ADD CONSTRAINT user_notification_sounds_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id);


--
-- Name: user_notification_sounds user_notification_sounds_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_sounds
    ADD CONSTRAINT user_notification_sounds_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_preferences user_preferences_theme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_theme_id_fkey FOREIGN KEY (theme_id) REFERENCES public.themes(id);


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_soundboard_shortcuts user_soundboard_shortcuts_sound_effect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_soundboard_shortcuts
    ADD CONSTRAINT user_soundboard_shortcuts_sound_effect_id_fkey FOREIGN KEY (sound_effect_id) REFERENCES public.custom_sound_effects(id);


--
-- Name: user_soundboard_shortcuts user_soundboard_shortcuts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_soundboard_shortcuts
    ADD CONSTRAINT user_soundboard_shortcuts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_voice_preferences user_voice_preferences_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_voice_preferences
    ADD CONSTRAINT user_voice_preferences_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id);


--
-- Name: user_voice_preferences user_voice_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_voice_preferences
    ADD CONSTRAINT user_voice_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: users users_avatar_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_avatar_asset_id_fkey FOREIGN KEY (avatar_asset_id) REFERENCES public.media_assets(id);


--
-- Name: users users_banner_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_banner_asset_id_fkey FOREIGN KEY (banner_asset_id) REFERENCES public.media_assets(id);


--
-- Name: voice_participants voice_participants_auth_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_participants
    ADD CONSTRAINT voice_participants_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES public.auth_sessions(id);


--
-- Name: voice_participants voice_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_participants
    ADD CONSTRAINT voice_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: voice_participants voice_participants_voice_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_participants
    ADD CONSTRAINT voice_participants_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id);


--
-- Name: voice_sessions voice_sessions_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id);


--
-- Name: voice_sessions voice_sessions_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.users(id);


--
-- Name: voice_tracks voice_tracks_participant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_tracks
    ADD CONSTRAINT voice_tracks_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES public.voice_participants(id);


--
-- PostgreSQL database dump complete
--

\unrestrict LPT6ANAc2Wtcg7PVsJ5oRQ1bBv7S5sz5ebjQZB8FACn2NAzurOavd0TZjZr9wgf
