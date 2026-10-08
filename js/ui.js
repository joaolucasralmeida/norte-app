/**
 * Utilitários de interface.
 *
 * `el()` monta DOM de verdade em vez de concatenar HTML. É mais verboso, mas
 * nenhum texto de usuário — descrição de lançamento, nome de meta, anotação —
 * é interpretado como HTML. Num app sem framework, é a diferença entre estar
 * protegido contra XSS por construção e depender de lembrar de escapar.
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') node.innerHTML = value; // só para conteúdo nosso
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }

  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

// --- Componentes recorrentes ----------------------------------------------

export function card(children, className = '') {
  return el('section', { class: `card ${className}`.trim() }, children);
}

export function sectionTitle(text, action) {
  return el('div', { class: 'section-head' }, [
    el('h2', {}, text),
    action ?? null,
  ]);
}

export function emptyState({ icon = '○', title, message, actionLabel, onAction }) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-icon' }, icon),
    el('h3', {}, title),
    el('p', {}, message),
    actionLabel ? el('button', { class: 'btn primary', onClick: onAction }, actionLabel) : null,
  ]);
}

export function progressBar(fraction, color = 'var(--accent)') {
  return el('div', {
    class: 'progress',
    role: 'progressbar',
    'aria-valuenow': Math.round(fraction * 100),
    'aria-valuemin': 0,
    'aria-valuemax': 100,
  }, [
    el('span', { style: { width: `${Math.min(100, Math.max(0, fraction * 100))}%`, background: color } }),
  ]);
}

export function row(label, value, options = {}) {
  return el('div', { class: `row ${options.class ?? ''}`.trim(), onClick: options.onClick }, [
    el('span', { class: 'row-label' }, label),
    el('span', { class: 'row-value' }, value),
  ]);
}

export function chip(text, { active = false, color, onClick } = {}) {
  return el('button', {
    class: `chip ${active ? 'active' : ''}`.trim(),
    onClick,
    type: 'button',
  }, [
    color ? el('span', { class: 'dot', style: { background: color } }) : null,
    text,
  ]);
}

// --- Campos de formulário --------------------------------------------------

export function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  return el('label', { class: 'field', for: id }, [
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null,
  ]);
}

export function input(props = {}) {
  return el('input', { class: 'input', ...props });
}

export function moneyInput(props = {}) {
  // inputmode decimal abre o teclado numérico do iOS com vírgula.
  return el('input', {
    class: 'input money',
    type: 'text',
    inputMode: 'decimal',
    placeholder: '0,00',
    autocomplete: 'off',
    ...props,
  });
}

export function select(options, props = {}) {
  const node = el('select', { class: 'input', ...props });
  for (const option of options) {
    node.append(el('option', { value: option.value, selected: option.selected }, option.label));
  }
  return node;
}

export function segmented(options, selected, onChange) {
  const wrapper = el('div', { class: 'segmented', role: 'tablist' });
  for (const option of options) {
    wrapper.append(el('button', {
      class: `seg ${option.value === selected ? 'active' : ''}`.trim(),
      type: 'button',
      role: 'tab',
      'aria-selected': String(option.value === selected),
      onClick: () => onChange(option.value),
    }, option.label));
  }
  return wrapper;
}

export function toggle(label, checked, onChange, hint) {
  const box = el('input', { type: 'checkbox', class: 'switch', checked, onChange: (e) => onChange(e.target.checked) });
  return el('label', { class: 'toggle' }, [
    el('span', {}, [el('span', { class: 'toggle-label' }, label), hint ? el('span', { class: 'field-hint' }, hint) : null]),
    box,
  ]);
}

// --- Folha modal -----------------------------------------------------------

const backdrop = () => document.getElementById('sheet-backdrop');
const sheetBody = () => document.getElementById('sheet-body');
const sheetTitle = () => document.getElementById('sheet-title');
const sheetConfirm = () => document.getElementById('sheet-confirm');
const sheetCancel = () => document.getElementById('sheet-cancel');

let activeConfirm = null;

export function openSheet({ title, body, confirmLabel = 'Salvar', onConfirm, hideConfirm = false }) {
  sheetTitle().textContent = title;
  clear(sheetBody()).append(body);

  const confirmButton = sheetConfirm();
  confirmButton.textContent = confirmLabel;
  confirmButton.hidden = hideConfirm;
  activeConfirm = onConfirm;

  backdrop().hidden = false;
  document.body.classList.add('no-scroll');
  // Foco no primeiro campo poupa um toque e orienta o VoiceOver.
  setTimeout(() => sheetBody().querySelector('input, select, textarea')?.focus(), 60);
}

export function closeSheet() {
  backdrop().hidden = true;
  document.body.classList.remove('no-scroll');
  activeConfirm = null;
  clear(sheetBody());
}

export function initSheet() {
  sheetCancel().addEventListener('click', closeSheet);
  sheetConfirm().addEventListener('click', async () => {
    if (!activeConfirm) return closeSheet();
    try {
      const result = await activeConfirm();
      if (result !== false) closeSheet();
    } catch (error) {
      toast(error.message ?? 'Não foi possível salvar.', 'error');
    }
  });
  backdrop().addEventListener('click', (event) => {
    if (event.target === backdrop()) closeSheet();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !backdrop().hidden) closeSheet();
  });
}

// --- Avisos ----------------------------------------------------------------

let toastTimer;

export function toast(message, variant = 'info') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast ${variant}`;
  node.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

export function confirmAction({ title, message, confirmLabel = 'Confirmar', destructive = false }) {
  return new Promise((resolve) => {
    const body = el('div', { class: 'stack' }, [el('p', {}, message)]);

    openSheet({
      title,
      body,
      confirmLabel,
      onConfirm: () => { resolve(true); return true; },
    });

    sheetConfirm().classList.toggle('danger', destructive);
    const onCancel = () => { resolve(false); sheetCancel().removeEventListener('click', onCancel); };
    sheetCancel().addEventListener('click', onCancel);
  });
}
