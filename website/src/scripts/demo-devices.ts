export function initializeDemoDevices() {
  const stages = [...document.querySelectorAll<HTMLElement>('[data-device]')];
  const narrow = matchMedia('(max-width:480px)');
  const reduced = matchMedia('(prefers-reduced-motion:reduce)');
  function fit(screen: HTMLElement) {
    const frame = screen.querySelector<HTMLIFrameElement>('iframe')!;
    const native = narrow.matches && screen.closest('[data-device]')?.getAttribute('data-device') !== 'desktop' && !screen.closest('.is-zoomed');
    const pixels = getComputedStyle(screen);
    const screenWidth = parseFloat(pixels.width);
    const width = native ? screenWidth : Number(screen.dataset.width);
    const height = native ? parseFloat(pixels.height) : Number(screen.dataset.height);
    frame.style.width = `${width}px`; frame.style.height = `${height}px`;
    frame.style.transform = `scale(${screenWidth / width})`;
  }
  const observer = new ResizeObserver(entries => entries.forEach(entry => fit(entry.target as HTMLElement)));
  stages.forEach(stage => { const screen = stage.querySelector<HTMLElement>('.device-screen')!; fit(screen); observer.observe(screen); });
  narrow.addEventListener('change', () => stages.forEach(stage => fit(stage.querySelector('.device-screen')!)));
  const scrim = document.createElement('div'); scrim.className = 'device-scrim'; scrim.hidden = true; document.body.append(scrim);
  let active: HTMLElement | null = null;
  let placeholder: HTMLElement | null = null;
  let trigger: HTMLButtonElement | null = null;
  let busy = false;
  let closeRequested = false;
  let savedOverflow = '';
  const inertElements: HTMLElement[] = [];
  function position(stage: HTMLElement) {
    const screen = stage.querySelector<HTMLElement>('.device-screen')!;
    const width = Number(screen.dataset.width); const height = Number(screen.dataset.height);
    const maximum = stage.dataset.device === 'desktop' ? 1240 : 446;
    const target = Math.min(maximum, innerWidth - 32, (innerHeight - 110) * width / height + 16);
    stage.style.setProperty('--zoom-width', `${Math.max(180, target)}px`);
    stage.style.setProperty('--zoom-left', `${(innerWidth - stage.offsetWidth) / 2}px`);
    stage.style.setProperty('--zoom-top', `${Math.max(16, (innerHeight - stage.offsetHeight) / 2)}px`);
    fit(screen);
  }
  function dimSiblings(stage: HTMLElement) {
    for (let node: HTMLElement | null = stage; node && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement?.children || []) {
        if (sibling === node || sibling === scrim || !(sibling instanceof HTMLElement) || sibling.inert) continue;
        sibling.inert = true; inertElements.push(sibling);
      }
    }
  }
  async function open(stage: HTMLElement, button: HTMLButtonElement) {
    if (busy || active) return; busy = true;
    document.querySelector('.phones')?.getAnimations().forEach(animation => animation.cancel());
    const start = stage.getBoundingClientRect();
    placeholder = document.createElement('div'); placeholder.className = 'device-placeholder';
    placeholder.style.width = `${start.width}px`; placeholder.style.height = `${start.height}px`;
    stage.before(placeholder);
    active = stage; trigger = button;
    stage.classList.add('is-zoomed'); stage.setAttribute('role', 'dialog'); stage.setAttribute('aria-modal', 'true');
    stage.setAttribute('aria-labelledby', `${button.dataset.open}-caption`);
    button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-label', 'Close expanded demonstration');
    position(stage); dimSiblings(stage);
    savedOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden';
    scrim.hidden = false;
    const end = stage.getBoundingClientRect();
    const duration = reduced.matches ? 0 : 380;
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease-out' });
    await stage.animate([{ transform: `translate(${start.left - end.left}px,${start.top - end.top}px) scale(${start.width / end.width},${start.height / end.height})` }, { transform: 'none' }], { duration, easing: 'cubic-bezier(.16,1,.3,1)' }).finished;
    button.focus({ preventScroll: true }); busy = false;
    if (closeRequested) { closeRequested = false; void close(); }
  }
  async function close() {
    if (!active || !placeholder) return;
    if (busy) { closeRequested = true; return; }
    busy = true;
    const stage = active; const start = stage.getBoundingClientRect(); const end = placeholder.getBoundingClientRect();
    const duration = reduced.matches ? 0 : 300;
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'ease-in' });
    await stage.animate([{ transform: 'none' }, { transform: `translate(${end.left - start.left}px,${end.top - start.top}px) scale(${end.width / start.width},${end.height / start.height})` }], { duration, easing: 'cubic-bezier(.5,0,.25,1)' }).finished;
    stage.classList.remove('is-zoomed'); stage.removeAttribute('role'); stage.removeAttribute('aria-modal'); stage.removeAttribute('aria-labelledby');
    ['--zoom-width', '--zoom-left', '--zoom-top'].forEach(property => stage.style.removeProperty(property));
    placeholder.remove(); placeholder = null; active = null; scrim.hidden = true;
    inertElements.splice(0).forEach(element => { element.inert = false; });
    document.documentElement.style.overflow = savedOverflow;
    trigger!.setAttribute('aria-expanded', 'false'); trigger!.setAttribute('aria-label', `Expand ${stage.querySelector('figcaption span')!.textContent!.toLowerCase()} demonstration`);
    fit(stage.querySelector('.device-screen')!); trigger!.focus({ preventScroll: true }); trigger = null; busy = false; closeRequested = false;
  }
  stages.forEach(stage => stage.querySelector<HTMLButtonElement>('[data-open]')?.addEventListener('click', event => {
    const button = event.currentTarget as HTMLButtonElement;
    if (active) void close(); else void open(stage, button);
  }));
  scrim.addEventListener('click', () => void close());
  window.addEventListener('resize', () => { if (active && !busy) position(active); });
  window.addEventListener('message', event => {
    if (active && event.origin === location.origin && event.source === active.querySelector('iframe')?.contentWindow && event.data?.type === 'brain-demo-escape') void close();
  });
  document.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); void close(); }
    if (event.key === 'Tab' && document.activeElement === trigger && event.shiftKey) { event.preventDefault(); active.querySelector('iframe')?.focus(); }
  });
}
