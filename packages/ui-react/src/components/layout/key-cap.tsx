/**
 * The printed key on the button it belongs to — "every shortcut is printed
 * where it applies, never hidden in help" (D36). Decorative to assistive
 * tech: the key is a sighted shortcut, the button's name is the action.
 */
export function KeyCap({ children }: { children: string }) {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 rounded border border-current/30 px-1 font-[family-name:var(--font-mono)] text-[9.5px] leading-[1.4] opacity-70"
    >
      {children}
    </span>
  );
}
