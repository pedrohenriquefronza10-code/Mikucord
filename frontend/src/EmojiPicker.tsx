import { useEffect, useRef } from 'react';
export function EmojiPicker({
  onSelect,
}: {
  onSelect: (emoji: { native?: string; id: string; src?: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    select = useRef(onSelect);
  select.current = onSelect;
  useEffect(() => {
    let active = true;
    void Promise.all([import('emoji-mart'), import('@emoji-mart/data')]).then(
      ([{ Picker }, data]) => {
        if (!active || !ref.current) return;
        const picker = new Picker({
          data: data.default,
          locale: 'pt',
          theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
          onEmojiSelect: (emoji: { native?: string; id: string }) => select.current(emoji),
          previewPosition: 'none',
          perLine: 7,
          skinTonePosition: 'search',
        });
        ref.current.replaceChildren(picker as unknown as Node);
      },
    );
    return () => {
      active = false;
      ref.current?.replaceChildren();
    };
  }, []);
  return <div className="full-emoji-picker" ref={ref} />;
}
