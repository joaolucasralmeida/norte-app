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
 * O link de convite ou de recuperação chega com o token no fragmento da URL.
 * Dois formatos, por razões diferentes:
 *
 * · `#token_hash=...&type=invite` — o nosso. A função `convidar` monta o
 *   endereço apontando direto para cá, e nós trocamos o token por sessão
 *   com `verifyOtp`. É o caminho que **não** depende do "Site URL" do
 *   projeto, que num projeto novo aponta para `http://localhost:3000` e só
 *   pode ser corrigido pelo painel.
 *
 * · `#access_token=...&type=recovery` — o do e-mail automático do Supabase,
 *   usado pelo "esqueci minha senha". Aqui o cliente já recebe a sessão
 *   pronta e consome o fragmento sozinho.
 */
export function chegouPorLinkDeSenha() {
  const fragmento = location.hash ?? '';
  return /type=(recovery|invite|signup)/.test(fragmento) || fragmento.includes('token_hash=');
}

/**
 * Troca `token_hash` por uma sessão. Devolve `null` quando o link não é
 * desse formato — aí quem resolve é o `detectSessionInUrl` do cliente.
 */
async function resgatarTokenHash() {
  const params = new URLSearchParams((location.hash ?? '').replace(/^#/, ''));
  const tokenHash = params.get('token_hash');
  if (!tokenHash) return null;

  const tipo = params.get('type') === 'recovery' ? 'recovery' : 'invite';
  const client = await getClient();
  const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: tipo });

  // Tira o token da barra de endereços assim que ele é usado: ele vale como
  // senha até ser consumido, e não deve ficar no histórico do navegador.
  history.replaceState(null, '', location.pathname + location.search);

  if (error) throw new Error(/expired|invalid/i.test(error.message)
    ? 'Este link expirou ou já foi usado. Peça um novo convite.'
    : error.message);

  return data.session ?? null;
}

export function renderAuth({ modo = 'entrar', onEntrou }) {
  const tela = el('div', { class: 'auth' });

  const desenhar = (atual) => {
    const forms = {
      definir: () => formDefinirSenha(onEntrou),
      entrar: () => formEntrar(onEntrou, () => desenhar('esqueci')),
      esqueci: () => formEsqueci(() => desenhar('entrar')),
    };

    // `replaceChildren` transforma `null` no texto "null" — diferente do
    // helper `el`, que descarta. Por isso a escolha é feita antes.
    tela.replaceChildren(
      el('div', { class: 'auth-marca' }, [
        el('img', { src: 'icons/norte-180-v3.png', alt: '', width: '64', height: '64' }),
        el('h1', {}, 'Norte'),
      ]),
      (forms[atual] ?? forms.entrar)(),
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

/**
 * Resolve o link de senha e devolve a sessão que ele abriu.
 *
 * Lança quando o link não vale mais — quem chama mostra o motivo, em vez de
 * deixar a pessoa diante de um formulário que vai falhar ao salvar.
 */
export async function sessaoDoLink() {
  const porTokenHash = await resgatarTokenHash();
  if (porTokenHash) return porTokenHash;

  const client = await getClient();
  const { data } = await client.auth.getSession();
  return data.session ?? null;
}

/** Tela de link inválido, com caminho de saída. */
export function renderLinkInvalido(mensagem) {
  return el('div', { class: 'auth' }, [
    el('div', { class: 'auth-marca' }, [
      el('img', { src: 'icons/norte-180-v3.png', alt: '', width: '64', height: '64' }),
      el('h1', {}, 'Norte'),
    ]),
    card([
      el('strong', {}, 'Link inválido'),
      el('p', { class: 'caption' }, mensagem),
      el('button', {
        class: 'btn primary wide',
        onClick: () => { location.hash = ''; location.reload(); },
      }, 'Ir para a tela de entrada'),
    ]),
  ]);
}
