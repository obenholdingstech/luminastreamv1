// Clean View (CEO directive, 3 Aug 2026): pressing "H" hides every piece of
// UI chrome, leaving only the raw video output and the synced audio — the
// stream exactly as a third-party platform's viewer would receive it.
//
// The only logic is the decision "does THIS keypress toggle the view", and
// it earns a lib file because the failure modes are all invisible in a
// component: H typed into the live-prompt field must restyle prompts, not
// blank the screen; a held-down key must not strobe; a shortcut chord
// (Cmd+H hides the window on macOS) belongs to the OS, not to us.

export function shouldToggleCleanView(event) {
  if (!event || event.repeat) return false;
  if (event.key !== 'h' && event.key !== 'H') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  const tag = (target?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
  if (target?.isContentEditable) return false;
  return true;
}
