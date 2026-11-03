export type Preferences = {
  theme_mode: 'dark' | 'light' | 'custom';
  theme_id?: string | null;
  palette?: Record<string, string>;
  base_mode?: 'dark' | 'light';
  timezone?: string;
  show_member_list: boolean;
  message_density: 'compact' | 'normal' | 'comfortable';
  chat_font_size: number;
};
export type User = {
  id: string;
  username: string;
  tag: string;
  avatar_asset_id: string | null;
  banner_asset_id: string | null;
  about_me: string;
  accent_color: string;
  preferred_status: string;
  custom_status_text: string;
  preferences: Preferences;
};
export type Guild = {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  icon_asset_id?: string | null;
  banner_asset_id?: string | null;
  boost_enabled?: boolean;
  boost_level?: number;
  tags?: string[];
  permissions?: string;
  visual_settings?: { palette?: Record<string, string> };
};
export type Channel = {
  id: string;
  name: string;
  type:
    | 'category'
    | 'text'
    | 'voice'
    | 'video'
    | 'announcement'
    | 'forum'
    | 'thread'
    | 'dm'
    | 'group_dm';
  guild_id?: string | null;
  group_owner_id?: string | null;
  members?: Array<Pick<User, 'id' | 'username' | 'tag' | 'avatar_asset_id' | 'accent_color'>>;
  topic: string;
  parent_id: string | null;
  permissions: string;
  slowmode_seconds: number;
  position?: number;
};
export type Role = {
  id: string;
  name: string;
  color: string | null;
  position: number;
  is_everyone?: boolean;
  permissions?: string;
  mentionable?: boolean;
  icon_asset_id?: string | null;
};
export type Member = Omit<User, 'preferences' | 'preferred_status'> & {
  nickname: string | null;
  status: string;
  roles: Role[];
};
export type Message = {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  version: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  attachments?: import('./Attachments').Attachment[];
  stickers?: Expression[];
  emojis?: Expression[];
  reactions?: Array<{
    emoji_key: string;
    unicode_emoji: string | null;
    custom_emoji_id: string | null;
    count: number;
    users: string[];
  }>;
  author: Pick<User, 'id' | 'username' | 'tag' | 'avatar_asset_id' | 'accent_color'>;
  reply: { id: string; content: string; deleted_at: string | null; username: string } | null;
};
export type Notice = {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  content: string;
  username: string;
  kind: string;
};

export type Expression = {
  id: string;
  name: string;
  asset_id: string;
  tags?: string[];
  category?: string;
  default_shortcut?: string | null;
  animated?: boolean;
  volume?: number;
};
export type Catalog = { emoji: Expression[]; sticker: Expression[]; sound: Expression[] };
