import { state, setSetting, wipeEverything, saveAccount, deleteAccount } from '../store.js';
import { storageEstimate } from '../db.js';
import { exportBackup, importBackup, backupStatus, dataSummary } from '../backup.js';
import { money, parseMoney, fmtDate } from '../format.js';
import {
  el, card, sectionTitle, openSheet, closeSheet, toast, confirmAction,
  field, input, moneyInput, select, toggle, row,
} from '../ui.js';
import { load } from '../store.js';

export function renderSettings() {
  return el('div', { class: 'stack' }, [
    el('button', { class: 'back-link', onClick: () => history.back() }, '‹ Voltar'),
    el('h2', {}, 'Configurações'),

    backupCard(),
    accountsCard(),
    assistantCard(),
    storageCard(),
    aboutCard(),
    dangerCard(),
  ]);
}

// ---------------------------------------------------------------------------

function backupCard() {
  const status = backupStatus();

  return card([
    sectionTitle('Backup'),
    el('p', { class: `caption ${status.level === 'warn' ? 'negative' : ''}`.trim() }, status.text),
    el('p', { class: 'caption' }, dataSummary()),

    el('div', { class: 'actions' }, [
      el('button', {
        class: 'btn primary grow',
        onClick: async () => {
          const result = await exportBackup();
          if (result?.cancelled) return;
          toast('Backup gerado. Guarde o arquivo em lugar seguro.');
          rerender();
        },
      }, 'Exportar backup'),

      el('button', { class: 'btn', onClick: openImportSheet }, 'Restaurar'),
    ]),

    el('p', { class: 'caption tiny' },
      'O arquivo é um JSON com tudo: lançamentos, metas, aportes, anotações e eventos. ' +
      'Não tem senha — guarde-o como você guardaria um extrato.'),
  ]);
}

function openImportSheet() {
  let file = null;

  const body = el('div', { class: 'stack' }, [
    el('p', {}, 'Restaurar substitui tudo o que está neste aparelho pelo conteúdo do arquivo.'),
    el('p', { class: 'caption' },
      'Não dá para mesclar: sem servidor, não há como decidir qual versão de um lançamento é a mais recente, ' +
      'e o resultado seriam duplicatas no seu extrato. Se tiver dados novos aqui, exporte antes.'),
    field('Arquivo de backup', input({
      type: 'file', accept: 'application/json,.json',
      onChange: (event) => { file = event.target.files?.[0] ?? null; },
    })),
  ]);

  openSheet({
    title: 'Restaurar backup',
    body,
    confirmLabel: 'Substituir tudo',
    onConfirm: async () => {
      if (!file) throw new Error('Escolha um arquivo primeiro.');
      const result = await importBackup(file);
      await load();
      toast(`Restaurado o backup de ${fmtDate(result.generatedAt)}.`);
      rerender();
      return true;
    },
  });
}

// ---------------------------------------------------------------------------

function accountsCard() {
  return card([
    sectionTitle('Contas', el('button', { class: 'mini-btn', onClick: () => openAccountSheet() }, '+ nova')),
    ...state.accounts.map((account) =>
      el('div', { class: 'row tappable', onClick: () => openAccountSheet(account) }, [
        el('span', { class: 'row-label' }, [
          el('span', { class: 'dot', style: { background: account.color ?? 'var(--accent)' } }),
          account.name,
          account.archived ? el('span', { class: 'caption' }, ' (arquivada)') : null,
        ]),
        el('span', { class: 'row-value caption' }, `saldo inicial ${money(account.initialBalanceCents)}`),
      ]),
    ),
  ]);
}

function openAccountSheet(existing = null) {
  const form = {
    name: existing?.name ?? '',
    initial: existing ? String(existing.initialBalanceCents / 100).replace('.', ',') : '',
    kind: existing?.kind ?? 'checking',
  };

  const body = el('div', { class: 'stack' }, [
    field('Nome', input({ value: form.name, onInput: (e) => { form.name = e.target.value; } })),
    field('Saldo inicial', moneyInput({ value: form.initial, onInput: (e) => { form.initial = e.target.value; } })),
    field('Tipo', select([
      { value: 'checking', label: 'Conta corrente', selected: form.kind === 'checking' },
      { value: 'savings', label: 'Poupança', selected: form.kind === 'savings' },
      { value: 'cash', label: 'Dinheiro', selected: form.kind === 'cash' },
      { value: 'credit_card', label: 'Cartão de crédito', selected: form.kind === 'credit_card' },
      { value: 'goal_reserve', label: 'Reserva de metas', selected: form.kind === 'goal_reserve' },
    ], { onChange: (e) => { form.kind = e.target.value; } })),

    existing
      ? el('button', {
          class: 'btn danger',
          onClick: async () => {
            closeSheet();
            const ok = await confirmAction({
              title: 'Excluir conta?',
              message: 'Se houver lançamentos nela, a conta é apenas arquivada para o histórico não sumir.',
              confirmLabel: 'Excluir', destructive: true,
            });
            if (!ok) return;
            const result = await deleteAccount(existing.id);
            toast(result.archived ? 'Conta arquivada (tinha lançamentos).' : 'Conta excluída.');
            rerender();
          },
        }, 'Excluir conta')
      : null,
  ]);

  openSheet({
    title: existing ? 'Editar conta' : 'Nova conta',
    body,
    onConfirm: async () => {
      if (!form.name.trim()) throw new Error('Dê um nome para a conta.');
      await saveAccount({
        ...(existing ?? {}),
        name: form.name.trim(),
        initialBalanceCents: parseMoney(form.initial),
        kind: form.kind,
      });
      rerender();
      return true;
    },
  });
}

// ---------------------------------------------------------------------------

function assistantCard() {
  const url = state.settings.backendURL ?? '';

  return card([
    sectionTitle('Assistente de IA'),
    el('p', { class: 'caption' },
      'Opcional. Sem um servidor configurado, o chat e a busca de preços ficam indisponíveis — ' +
      'o resto do app funciona normalmente, offline.'),

    field('Endereço do servidor', input({
      type: 'url', value: url, placeholder: 'https://…',
      onChange: async (event) => {
        await setSetting('backendURL', event.target.value.trim());
        toast('Servidor salvo.');
      },
    }), 'O backend em Node deste projeto, publicado em algum lugar com https.'),

    toggle('Enviar resumo financeiro ao assistente',
      Boolean(state.settings.sendSnapshot),
      async (value) => { await setSetting('sendSnapshot', value); },
      'Apenas médias mensais e metas ativas. Nunca lançamentos, saldos por conta ou anotações.'),
  ]);
}

// ---------------------------------------------------------------------------

function storageCard() {
  const node = card([
    sectionTitle('Armazenamento'),
    el('p', { class: 'caption' },
      state.storage.persisted
        ? '✓ O navegador marcou seus dados como persistentes.'
        : 'O navegador não garantiu persistência. É o comportamento normal no iOS — por isso o backup importa.'),
    el('p', { class: 'caption', id: 'storage-usage' }, 'Calculando uso…'),
  ]);

  storageEstimate().then((estimate) => {
    const target = document.getElementById('storage-usage');
    if (!target) return;
    target.textContent = estimate
      ? `Usando ${formatBytes(estimate.usage)} de aproximadamente ${formatBytes(estimate.quota)} disponíveis.`
      : 'Este navegador não informa o uso de armazenamento.';
  });

  return node;
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function aboutCard() {
  return card([
    sectionTitle('Sobre'),
    row('Versão', '1.0.0 (web)'),
    row('Onde ficam seus dados', 'Somente neste aparelho'),
    el('p', { class: 'caption' },
      'Nada é enviado para servidor nenhum, exceto o texto que você digitar no assistente — e só se você configurar um servidor.'),
  ]);
}

function dangerCard() {
  return card([
    sectionTitle('Apagar tudo'),
    el('p', { class: 'caption' },
      'Remove lançamentos, metas, aportes, anotações e eventos deste aparelho. Não dá para desfazer.'),
    el('button', {
      class: 'btn danger',
      onClick: async () => {
        const ok = await confirmAction({
          title: 'Apagar todos os dados?',
          message: 'Exporte um backup antes se quiser poder voltar. Esta ação não tem desfazer.',
          confirmLabel: 'Apagar tudo', destructive: true,
        });
        if (!ok) return;
        await wipeEverything();
        toast('Tudo apagado.');
        rerender();
      },
    }, 'Apagar todos os dados'),
  ], 'danger-card');
}

function rerender() {
  window.dispatchEvent(new CustomEvent('norte:rerender'));
}
