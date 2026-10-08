import { state, saveNote, deleteNote } from '../store.js';
import { fmtDateTime } from '../format.js';
import {
  el, card, emptyState, openSheet, toast, confirmAction, field, input,
} from '../ui.js';

let searchTerm = '';
let activeTag = null;

export function renderJournal() {
  const screen = el('div', { class: 'stack' });

  if (state.notes.length === 0) {
    screen.append(emptyState({
      icon: '▤',
      title: 'Nenhuma anotação',
      message: 'Registre decisões, ideias e o que mudou no seu mês.',
      actionLabel: 'Escrever',
      onAction: () => openNoteSheet(),
    }), fab());
    return screen;
  }

  screen.append(toolbar(), tagFilters(), list(), fab());
  return screen;
}

function fab() {
  return el('button', { class: 'fab', onClick: () => openNoteSheet(), 'aria-label': 'Nova anotação' }, '+');
}

function toolbar() {
  return el('div', { class: 'toolbar' }, [
    input({
      type: 'search', placeholder: 'Buscar nas anotações', value: searchTerm,
      onInput: (event) => { searchTerm = event.target.value; rerender(); },
    }),
  ]);
}

function tagFilters() {
  const tags = [...new Set(state.notes.flatMap((note) => note.tags))].sort();
  if (tags.length === 0) return el('div');

  return el('div', { class: 'hscroll chips' }, tags.map((tag) =>
    el('button', {
      class: `chip ${activeTag === tag ? 'active' : ''}`.trim(),
      onClick: () => { activeTag = activeTag === tag ? null : tag; rerender(); },
    }, `# ${tag}`),
  ));
}

function visibleNotes() {
  const term = searchTerm.trim().toLowerCase();

  return state.notes
    .filter((note) => !activeTag || note.tags.includes(activeTag))
    .filter((note) => !term || `${note.title} ${note.body} ${note.tags.join(' ')}`.toLowerCase().includes(term))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function list() {
  const notes = visibleNotes();

  if (notes.length === 0) {
    return emptyState({ icon: '🔎', title: 'Nada encontrado', message: 'Tente outro termo ou limpe o filtro.' });
  }

  return el('div', { class: 'stack' }, notes.map((note) =>
    el('button', { class: 'note', onClick: () => openNoteSheet(note) }, [
      el('div', { class: 'note-head' }, [
        el('strong', {}, note.title || 'Sem título'),
        el('span', { class: 'caption tiny' }, fmtDateTime(note.createdAt)),
      ]),
      note.body ? el('p', { class: 'note-preview' }, note.body) : null,
      note.tags.length
        ? el('div', { class: 'note-tags' }, note.tags.map((tag) => el('span', { class: 'tag' }, `# ${tag}`)))
        : null,
    ]),
  ));
}

function openNoteSheet(existing = null) {
  const form = {
    title: existing?.title ?? '',
    body: existing?.body ?? '',
    tags: (existing?.tags ?? []).join(', '),
  };

  const body = el('div', { class: 'stack' }, [
    field('Título', input({
      value: form.title, placeholder: 'Ex.: Revisão do mês',
      onInput: (e) => { form.title = e.target.value; },
    })),

    field('Anotação', el('textarea', {
      class: 'input textarea', rows: 10, value: form.body,
      placeholder: 'O que aconteceu, o que mudou, o que decidir…',
      onInput: (e) => { form.body = e.target.value; },
    })),

    field('Tags', input({
      value: form.tags, placeholder: 'economia, balanço',
      onInput: (e) => { form.tags = e.target.value; },
    }), 'Separadas por vírgula'),

    // Honestidade sobre o que esta versão não faz: no app nativo havia nota
    // privada com AES-GCM e Face ID. Na web, sem Keychain e sem biometria
    // confiável, uma "nota privada" seria segurança de fachada.
    el('p', { class: 'caption' },
      'Esta versão não tem anotação privada criptografada. Evite escrever aqui senhas ou dados que você não queira em um backup sem senha.'),

    existing
      ? el('button', {
          class: 'btn danger',
          onClick: async () => {
            const ok = await confirmAction({
              title: 'Excluir anotação?',
              message: `"${existing.title || 'Sem título'}" será removida.`,
              confirmLabel: 'Excluir', destructive: true,
            });
            if (!ok) return;
            await deleteNote(existing.id);
            toast('Anotação excluída.');
            rerender();
          },
        }, 'Excluir anotação')
      : null,
  ]);

  openSheet({
    title: existing ? 'Anotação' : 'Nova anotação',
    body,
    confirmLabel: 'Concluir',
    onConfirm: async () => {
      await saveNote({
        id: existing?.id,
        createdAt: existing?.createdAt,
        title: form.title,
        body: form.body,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      rerender();
      return true;
    },
  });
}

function rerender() {
  window.dispatchEvent(new CustomEvent('norte:rerender'));
}
