import { create } from 'zustand';
import type { User } from './types';
type State = {
  user: User | null;
  guildId: string | null;
  channelId: string | null;
  mode: 'guild' | 'home' | 'dm';
  focusMessageId: string | null;
  selectHome: () => void;
  selectConversation: (id: string) => void;
  focusMessage: (id: string | null) => void;
  toast: string;
  setUser: (u: User | null) => void;
  selectGuild: (id: string) => void;
  selectChannel: (id: string | null) => void;
  notify: (message: string) => void;
};
let toastTimer: ReturnType<typeof setTimeout>;
export const useStore = create<State>((set) => ({
  user: null,
  guildId: null,
  channelId: null,
  mode: 'guild',
  focusMessageId: null,
  selectHome: () => set({ mode: 'home', guildId: null, channelId: null, focusMessageId: null }),
  selectConversation: (channelId) =>
    set({ mode: 'dm', guildId: null, channelId, focusMessageId: null }),
  focusMessage: (focusMessageId) => set({ focusMessageId }),
  toast: '',
  setUser: (user) => set({ user }),
  selectGuild: (guildId) => set({ guildId, channelId: null, mode: 'guild', focusMessageId: null }),
  selectChannel: (channelId) => set({ channelId, focusMessageId: null }),
  notify: (toast) => {
    clearTimeout(toastTimer);
    set({ toast });
    toastTimer = setTimeout(() => set({ toast: '' }), 5000);
  },
}));
