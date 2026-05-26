/**
 * Toast notifications — bottom-right floating cards with close buttons,
 * pause-on-hover, and a small progress bar showing remaining time.
 */

const container = document.getElementById('toast-container');
let nextId = 1;

const ICONS = {
  info:    'ℹ',
  success: '✓',
  warning: '⚠',
  error:   '✗',
};

export function toast(message, type = 'info', duration = 4000) {
  if (!container) return null;

  const id = nextId++;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'status');
  el.setAttribute('data-id', String(id));

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = ICONS[type] || ICONS.info;

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '✕';

  const progress = document.createElement('div');
  progress.className = 'toast-progress';
  // Drive the timer via CSS animation. duration in seconds for animation
  progress.style.animationDuration = `${duration}ms`;

  el.appendChild(icon);
  el.appendChild(msg);
  el.appendChild(closeBtn);
  el.appendChild(progress);
  container.appendChild(el);

  let dismissTimer;
  let dismissed = false;

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(dismissTimer);
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 220);
  };

  closeBtn.addEventListener('click', dismiss);

  // Pause auto-dismiss while hovered
  el.addEventListener('mouseenter', () => {
    progress.style.animationPlayState = 'paused';
    clearTimeout(dismissTimer);
  });
  el.addEventListener('mouseleave', () => {
    progress.style.animationPlayState = 'running';
    dismissTimer = setTimeout(dismiss, duration);
  });

  // Click anywhere on the toast (except close) → dismiss
  el.addEventListener('click', (e) => {
    if (e.target === closeBtn) return;
    dismiss();
  });

  if (duration > 0) {
    dismissTimer = setTimeout(dismiss, duration);
  }

  return { dismiss };
}

// Convenience exports
export const success = (m, d) => toast(m, 'success', d);
export const warning = (m, d) => toast(m, 'warning', d);
export const error   = (m, d) => toast(m, 'error',   d);
export const info    = (m, d) => toast(m, 'info',    d);
