import {
  state, setSetting, wipeEverything, saveAccount, deleteAccount,
  replaceExternalEvents, clearExternalEvents,
} from '../store.js';
import { requestToken, listCalendars, fetchAllEvents, hasValidToken, forgetToken } from '../google-calendar.js';
import { parseICS } from '../ics.js';


import { shareICS } from '../ics.js';
import { money, parseMoney, fmtDate } from '../format.js';
import {
  el, card, sectionTitle, openSheet, closeSheet, toast, confirmAction,
  field, input, moneyInput, select, toggle, row,
} from '../ui.js';
import { load } from '../store.js';
import { cloudConfigured } from '../cloud/config.js';
import { currentSession, signOut } from '../cloud/client.js';
import { sincronizar, pendencias, limparCopiaLocal } from '../cloud/sync.js';
import { meuPapel, listarPessoas, convidar as convidarPessoa } from '../cloud/admin.js';

export function renderSettings() {
  return el('div', { class: 'stack' }, [
    el('button', { class: 'back-link', onClick: () => history.back() }, '‹ Voltar'),
    el('h2', {}, 'Configurações'),

    accountCard(),
    peopleCard(),
    calendarsCard(),
    accountsCard(),
    assistantCard(),
    aboutCard(),
    dangerCard(),
  ]);
}

// ---------------------------------------------------------------------------
// Agendas externas
// ---------------------------------------------------------------------------

function calendarsCard() {
  const googleEvents = state.externalEvents.filter((e) => e.source === 'google').length;
  const icsEvents = state.externalEvents.filter((e) => e.source === 'ics').length;
  const clientId = state.settings.googleClientId ?? '';
  const ultimaSync = state.settings.googleSyncedAt;

  return card([
    sectionTitle('Outras agendas'),
    el('p', { class: 'caption' },
      'Traga seus compromissos para a aba Calendário e veja tudo junto: parcelas, metas e a sua agenda.'),

    // --- Google ---
    el('div', { class: 'stack-xs' }, [
      el('strong', {}, 'Google Calendar'),
      googleEvents > 0
        ? el('span', { class: 'caption positive' },
            `${googleEvents} eventos${ultimaSync ? ` · atualizado em ${fmtDate(ultimaSync)}` : ''}`)
        : el('span', { class: 'caption' }, 'Não conectado'),

      field('Client ID do Google', input({
        value: clientId, placeholder: '…apps.googleusercontent.com',
        onChange: async (event) => { await setSetting('googleClientId', event.target.value.trim()); },
      }), 'Criado por você no Google Cloud. É público — não é senha.'),

      el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn primary',
          disabled: !clientId,
          onClick: () => conectarGoogle(),
        }, googleEvents > 0 ? 'Atualizar agora' : 'Conectar'),

        googleEvents > 0
          ? el('button', {
              class: 'btn danger',
              onClick: async () => {
                await clearExternalEvents('google');
                await setSetting('googleSyncedAt', null);
                forgetToken();
                toast('Google desconectado.');
                rerender();
              },
            }, 'Desconectar')
          : null,
      ]),
    ]),

    el('hr'),

    // --- Arquivo .ics ---
    el('div', { class: 'stack-xs' }, [
      el('strong', {}, 'Arquivo de calendário (.ics)'),
      el('p', { class: 'caption' },
        'É o único jeito de trazer o calendário do próprio iPhone (iCloud) — ' +
        'não existe API web que leia o app Calendário. Serve também para Outlook e Google.'),
      icsEvents > 0
        ? el('span', { class: 'caption positive' }, `${icsEvents} eventos importados`)
        : null,

      field('Escolher arquivo', input({
        type: 'file', accept: '.ics,text/calendar',
        onChange: (event) => importarICS(event.target.files?.[0]),
      })),

      icsEvents > 0
        ? el('button', {
            class: 'btn danger',
            onClick: async () => {
              await clearExternalEvents('ics');
              toast('Eventos importados removidos.');
              rerender();
            },
          }, 'Remover eventos importados')
        : null,
    ]),

    el('p', { class: 'caption tiny' },
      'Agendas externas entram só para leitura: o Norte mostra os eventos e nunca altera nada na origem. ' +
      'Elas também ficam de fora da exportação, para não duplicar o que já está no seu Calendário.'),
  ]);
}

async function conectarGoogle() {
  const clientId = state.settings.googleClientId;
  if (!clientId) return;

  toast('Abrindo autorização do Google…');

  try {
    const token = await requestToken(clientId, { interactive: !hasValidToken() });
    const agendas = await listCalendars(token);
    const selecionadas = agendas.filter((c) => c.selected).map((c) => c.id);

    const { events, failures } = await fetchAllEvents(token, selecionadas, { days: 120 });
    const total = await replaceExternalEvents('google', events);
    await setSetting('googleSyncedAt', new Date().toISOString());

    toast(failures.length
      ? `${total} eventos importados, ${failures.length} agenda(s) falharam.`
      : `${total} eventos de ${selecionadas.length} agenda(s).`);
    rerender();
  } catch (error) {
    toast(error.message ?? 'Não consegui conectar ao Google.', 'error');
  }
}

async function importarICS(file) {
  if (!file) return;

  try {
    const texto = await file.text();
    const eventos = parseICS(texto);

    if (eventos.length === 0) {
      toast('Nenhum evento futuro encontrado nesse arquivo.', 'error');
      return;
    }

    await replaceExternalEvents('ics', eventos);
    toast(`${eventos.length} eventos importados.`);
    rerender();
  } catch (error) {
    toast('Não consegui ler esse arquivo .ics.', 'error');
  }
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

/**
 * Conta e sincronização.
 *
 * Só aparece quando a sincronização está configurada — sem isso o app é o que
 * sempre foi, um aplicativo de um aparelho só, e um cartão falando de conta
 * seria mentira.
 */
function accountCard() {
  if (!cloudConfigured()) return null;

  const estado = el('span', { class: 'caption' }, 'verificando…');
  const ponto = el('span', { class: 'sync-ponto' });
  const quem = el('strong', {}, '—');

  const atualizar = async () => {
    const sessao = await currentSession();
    quem.textContent = sessao?.user?.email ?? 'não conectado';

    const fila = await pendencias();
    if (!navigator.onLine) {
      ponto.className = 'sync-ponto offline';
      estado.textContent = fila
        ? `Sem conexão · ${fila} alteração(ões) esperando para subir`
        : 'Sem conexão · tudo que havia já subiu';
      return;
    }
    ponto.className = fila ? 'sync-ponto pendente' : 'sync-ponto';
    estado.textContent = fila ? `${fila} alteração(ões) para enviar` : 'Tudo sincronizado';
  };

  const agora = el('button', {
    class: 'btn',
    onClick: async () => {
      agora.disabled = true;
      agora.textContent = 'Sincronizando…';
      try {
        const { recebidos = 0, enviados = 0 } = await sincronizar();
        toast(`Sincronizado: ${recebidos} recebido(s), ${enviados} enviado(s).`);
        await load();
      } catch (error) {
        toast(`Falhou: ${error.message}`);
      }
      agora.disabled = false;
      agora.textContent = 'Sincronizar agora';
      atualizar();
    },
  }, 'Sincronizar agora');

  const sair = el('button', {
    class: 'btn danger',
    onClick: async () => {
      const fila = await pendencias();
      const aviso = fila
        ? `Há ${fila} alteração(ões) que ainda não subiram. Sair agora as descarta. Continuar?`
        : 'Sair da conta? Os dados deste aparelho serão apagados — eles continuam no servidor.';
      if (!(await confirmAction(aviso))) return;

      // Apagar a cópia local é o ponto da coisa: num computador compartilhado,
      // deixá-la significaria que o próximo a abrir o app veria tudo sem senha.
      await limparCopiaLocal();
      await signOut();
      location.reload();
    },
  }, 'Sair da conta');

  atualizar();

  return card([
    sectionTitle('Sua conta'),
    quem,
    el('div', { class: 'sync-linha' }, [ponto, estado]),
    el('div', { class: 'actions' }, [agora, sair]),
    el('p', { class: 'caption tiny' },
      'Seus dados ficam neste aparelho e no servidor. Entrar com o mesmo e-mail em '
      + 'outro computador traz tudo para lá.'),
  ]);
}

/**
 * Convidar pessoas. Só aparece para administradores.
 *
 * Esconder o cartão de quem não é admin é conveniência, não segurança: quem
 * editar o JavaScript da página faz ele aparecer. Quem recusa de verdade é a
 * função no servidor, que confere o papel antes de convidar.
 */
function peopleCard() {
  if (!cloudConfigured()) return null;

  const corpo = el('div', { class: 'stack-xs' }, [el('span', { class: 'caption' }, 'carregando…')]);
  const bloco = card([sectionTitle('Pessoas'), corpo]);
  bloco.hidden = true;

  (async () => {
    const perfil = await meuPapel();
    if (perfil?.role !== 'admin') return;
    bloco.hidden = false;

    const email = input({ type: 'email', placeholder: 'pessoa@exemplo.com' });
    const nome = input({ type: 'text', placeholder: 'Nome completo' });
    const aviso = el('p', { class: 'caption' });

    const enviar = async () => {
      aviso.className = 'caption';
      botao.disabled = true;
      botao.textContent = 'Gerando…';
      try {
        const { link, tipo } = await convidarPessoa(email.value, nome.value);
        aviso.className = 'caption positive';
        // O mesmo botão serve para os dois casos: quem não tem conta recebe
        // um convite, quem já tem recebe um link de redefinição de senha.
        // É assim que alguém que esqueceu a senha volta a entrar sem
        // depender do e-mail automático.
        aviso.textContent = tipo === 'recovery'
          ? `${email.value.trim()} já tem conta. O link abaixo permite definir uma senha nova.`
          : `Conta criada para ${email.value.trim()}. Envie o link abaixo — a pessoa escolhe a própria senha.`;
        mostrarLink(link);
        email.value = '';
        nome.value = '';
        atualizarLista();
      } catch (error) {
        aviso.className = 'caption negative';
        aviso.textContent = error.message;
      }
      botao.disabled = false;
      botao.textContent = 'Gerar link';
    };

    const botao = el('button', { class: 'btn primary', onClick: enviar }, 'Gerar link');
    const lista = el('div', { class: 'stack-xs' });
    const caixaLink = el('div', { class: 'stack-xs' });

    /**
     * O link vale como senha até ser usado uma vez. Por isso ele aparece
     * aqui para ser copiado e enviado pelo canal que o admin escolher, em
     * vez de sair por e-mail automático — que, além do limite de 2 por hora
     * do plano gratuito, apontaria para o endereço errado.
     */
    const mostrarLink = (link) => {
      if (!link) return;
      const campo = input({ type: 'text', value: link, readonly: true });
      campo.addEventListener('focus', () => campo.select());

      caixaLink.replaceChildren(
        field('Link de primeiro acesso', campo),
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn',
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(link);
                toast('Link copiado.');
              } catch {
                campo.select();
                toast('Selecione e copie o link acima.');
              }
            },
          }, 'Copiar link'),
          el('button', { class: 'btn', onClick: () => caixaLink.replaceChildren() }, 'Esconder'),
        ]),
        el('p', { class: 'caption warn' },
          '⚠ Esse link entra na conta sem pedir senha, até ser usado uma vez. '
          + 'Mande por um canal privado e não o republique.'),
      );
    };

    const atualizarLista = async () => {
      try {
        const pessoas = await listarPessoas();
        lista.replaceChildren(
          el('span', { class: 'caption' }, `COM ACESSO (${pessoas.length})`),
          ...pessoas.map((p) => el('div', { class: 'row' }, [
            el('span', {}, p.full_name || 'sem nome'),
            el('span', { class: 'badge' }, p.role === 'admin' ? 'administrador' : 'membro'),
          ])),
        );
      } catch {
        lista.replaceChildren(el('span', { class: 'caption' }, 'Não consegui carregar a lista.'));
      }
    };

    corpo.replaceChildren(
      el('p', { class: 'caption' },
        'Digite o e-mail: se a pessoa ainda não tem conta, isto cria uma; se já tem, gera '
        + 'um link para ela definir uma senha nova. Em nenhum dos casos uma senha é criada '
        + 'aqui ou enviada por mensagem.'),
      field('E-mail', email),
      field('Nome', nome),
      aviso,
      botao,
      caixaLink,
      lista,
      el('p', { class: 'caption tiny' },
        'Cada pessoa vê apenas os próprios lançamentos, metas e anotações. '
        + 'Não há dado compartilhado entre contas.'),
    );
    atualizarLista();
  })();

  return bloco;
}

function assistantCard() {
  // O campo "endereço do servidor" saiu: o endereço agora vem do código
  // (ASSISTANT_URL) e é o mesmo para todos os aparelhos. Ele existia de
  // quando o servidor ainda não estava publicado e cada um apontava para o
  // seu — era configuração sem escolha a fazer.
  return card([
    sectionTitle('Assistente de IA'),
    el('p', { class: 'caption' },
      'Já configurado. Pergunte um preço no botão ✦ e ele prepara uma meta de compra.'),

    toggle('Enviar resumo financeiro ao assistente',
      Boolean(state.settings.sendSnapshot),
      async (value) => { await setSetting('sendSnapshot', value); },
      'Apenas médias mensais e metas ativas. Nunca lançamentos, saldos por conta ou anotações.'),

    // O usuário precisa saber disso ANTES de ligar o toggle acima, não depois.
    el('p', { class: 'caption warn' },
      '⚠ No nível gratuito do Gemini, o Google pode usar o que você envia para treinar os modelos dele. '
      + 'Perguntar preço de produto não revela nada seu; o resumo financeiro, sim. '
      + 'Com faturamento ativado no Google AI Studio, essa política não se aplica.'),

    el('p', { class: 'caption tiny' },
      'A pesquisa de preços usa a Tavily, limitada a 1.000 buscas por mês no plano gratuito. '
      + 'Só o nome do produto é enviado a ela.'),
  ]);
}

// ---------------------------------------------------------------------------

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
      'Remove lançamentos, metas, aportes, anotações e eventos — neste aparelho E no servidor, '
      + 'em todos os aparelhos onde você entra com esta conta. Não dá para desfazer.'),
    el('button', {
      class: 'btn danger',
      onClick: async () => {
        const ok = await confirmAction({
          title: 'Apagar todos os dados?',
          message: 'Isso apaga também o que está no servidor, e some dos outros aparelhos na '
            + 'próxima sincronização. Não tem desfazer.',
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
