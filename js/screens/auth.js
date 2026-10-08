/**
 * Tela de entrada.
 *
 * Aparece antes do app quando a sincronização está configurada e não há
 * sessão. Ela cobre três situações que parecem a mesma mas não são:
 *
 * · **entrar** — e-mail e senha de quem já tem conta;
 * · **definir senha** — primeiro acesso por convite, ou recuperação. O
 *   Supabase devolve a pessoa para cá já autenticada, com uma sessão
 *   temporária, e o que falta é escolher a senha;
 * · **esqueci** — dispara o e-mail de recuperação.
 *
 * Não há cadastro aqui de propósito. Conta nova é feita por convite no painel
 * do Supabase; com cadastro aberto, qualquer pessoa na internet criaria uma.
 */

import { el, card, input, field, toast } from '../ui.js';
import { signIn, sendReset, updatePassword, getClient } from '../cloud/client.js';

/**
 * O link do convite e o de recuperação chegam com o token no fragmento da
 * URL (`#access_token=...&type=recovery`). O cliente do Supabase consome e
 * limpa isso sozinho, então precisamos olhar antes que ele apague.
 */
export function chegouPorLinkDeSenha() {
  const fragmento = location.hash ?? '';
  return /type=(recovery|invite|signup)/.test(fragmento);
}

export function renderAuth({ modo = 'entrar', onEntrou }) {
  const tela = el('div', { class: 'auth' });

  const desenhar = (atual) => {
    tela.replaceChildren(
      el('div', { class: 'auth-marca' }, [
        el('img', { src: 'icons/norte-180-v3.png', alt: '', width: '64', height: '64' }),
        el('h1', {}, 'Norte'),
      ]),
      atual === 'definir' ? formDefinirSenha(onEntrou) : null,
      atual === 'entrar' ? formEntrar(onEntrou, () => desenhar('esqueci')) : null,
      atual === 'esqueci' ? formEsqueci(() => desenhar('entrar')) : null,
    );
  };

  desenhar(modo);
  return tela;
}

// ---------------------------------------------------------------------------

function formEntrar(onEntrou, aoEsquecer) {
  const email = input({ type: 'email', placeholder: 'voce@exemplo.com', autocomplete: 'username' });
  const senha = input({ type: 'password', placeholder: '••••••••', autocomplete: 'current-password' });
  const aviso = el('p', { class: 'caption negative' });

  const entrar = async () => {
    aviso.textContent = '';
    botao.disabled = true;
    botao.textContent = 'Entrando…';
    try {
      await signIn(email.value, senha.value);
      await onEntrou();
    } catch (error) {
      aviso.textContent = error.message;
      botao.disabled = false;
      botao.textContent = 'Entrar';
    }
  };

  const botao = el('button', { class: 'btn primary wide', onClick: entrar }, 'Entrar');
  senha.addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });

  return card([
    el('p', { class: 'caption' }, 'Entre para ver seus dados em qualquer aparelho.'),
    field('E-mail', email),
    field('Senha', senha),
    aviso,
    botao,
    el('button', { class: 'btn link-btn', onClick: aoEsquecer }, 'Esqueci minha senha'),
  ]);
}

function formEsqueci(aoVoltar) {
  const email = input({ type: 'email', placeholder: 'voce@exemplo.com', autocomplete: 'username' });
  const aviso = el('p', { class: 'caption' });

  const enviar = async () => {
    aviso.className = 'caption';
    try {
      await sendReset(email.value);
      // Mensagem igual tendo ou não a conta: dizer "esse e-mail não existe"
      // entregaria a estranhos quem tem conta aqui.
      aviso.textContent = 'Se existir uma conta com esse e-mail, o link de recuperação acabou de ser enviado.';
    } catch (error) {
      aviso.className = 'caption negative';
      aviso.textContent = error.message;
    }
  };

  return card([
    el('p', { class: 'caption' }, 'Enviamos um link para você definir uma senha nova.'),
    field('E-mail', email),
    aviso,
    el('button', { class: 'btn primary wide', onClick: enviar }, 'Enviar link'),
    el('button', { class: 'btn link-btn', onClick: aoVoltar }, 'Voltar'),
  ]);
}

function formDefinirSenha(onEntrou) {
  const senha = input({ type: 'password', placeholder: 'pelo menos 8 caracteres', autocomplete: 'new-password' });
  const repete = input({ type: 'password', placeholder: 'repita a senha', autocomplete: 'new-password' });
  const aviso = el('p', { class: 'caption negative' });

  const salvar = async () => {
    aviso.textContent = '';

    // O Supabase aceita 6 por padrão. Exigimos 8 aqui porque esta senha
    // protege lançamentos financeiros, e seis caracteres são adivinháveis.
    if (senha.value.length < 8) { aviso.textContent = 'Use pelo menos 8 caracteres.'; return; }
    if (senha.value !== repete.value) { aviso.textContent = 'As duas senhas não são iguais.'; return; }

    botao.disabled = true;
    botao.textContent = 'Salvando…';
    try {
      await updatePassword(senha.value);
      toast('Senha definida.');
      await onEntrou();
    } catch (error) {
      aviso.textContent = error.message;
      botao.disabled = false;
      botao.textContent = 'Salvar e entrar';
    }
  };

  const botao = el('button', { class: 'btn primary wide', onClick: salvar }, 'Salvar e entrar');
  repete.addEventListener('keydown', (e) => { if (e.key === 'Enter') salvar(); });

  return card([
    el('strong', {}, 'Defina sua senha'),
    el('p', { class: 'caption' }, 'É o seu primeiro acesso. Escolha uma senha para entrar daqui em diante.'),
    field('Nova senha', senha),
    field('Confirme', repete),
    aviso,
    botao,
  ]);
}

/** Espera o cliente processar o token do link antes de decidir o que mostrar. */
export async function sessaoDoLink() {
  const client = await getClient();
  const { data } = await client.auth.getSession();
  return data.session ?? null;
}
