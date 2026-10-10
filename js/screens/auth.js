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
 * Abre sessão a partir do fragmento de um link de autenticação.
 *
 * Aceita os dois formatos, porque eles vêm de caminhos diferentes:
 *
 * · `token_hash=...` — o convite gerado pela nossa função. Trocado por
 *   sessão com `verifyOtp`.
 * · `access_token=...&refresh_token=...` — o e-mail de recuperação do
 *   próprio Supabase, que já entrega a sessão pronta.
 *
 * Devolve `null` quando não há nada de autenticação no texto.
 */
async function abrirSessaoDoFragmento(fragmento) {
  const params = new URLSearchParams(String(fragmento ?? '').replace(/^.*#/, ''));
  const client = await getClient();

  const tokenHash = params.get('token_hash');
  if (tokenHash) {
    const tipo = params.get('type') === 'recovery' ? 'recovery' : 'invite';
    const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: tipo });
    if (error) throw new Error(traduzirLink(error.message));
    return data.session ?? null;
  }

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) {
    const { data, error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw new Error(traduzirLink(error.message));
    return data.session ?? null;
  }

  return null;
}

const traduzirLink = (mensagem) => (/expired|invalid|otp/i.test(mensagem)
  ? 'Este link expirou ou já foi usado. Peça um novo.'
  : mensagem);

/** O mesmo, lendo da barra de endereços. */
async function resgatarDaURL() {
  const sessao = await abrirSessaoDoFragmento(location.hash);
  if (!sessao) return null;

  // Tira o token da barra de endereços assim que ele é usado: ele vale como
  // senha até ser consumido, e não deve ficar no histórico do navegador.
  history.replaceState(null, '', location.pathname + location.search);
  return sessao;
}

export function renderAuth({ modo = 'entrar', onEntrou }) {
  const tela = el('div', { class: 'auth' });

  const desenhar = (atual) => {
    const forms = {
      definir: () => formDefinirSenha(onEntrou),
      entrar: () => formEntrar(onEntrou, () => desenhar('esqueci'), () => desenhar('colar')),
      esqueci: () => formEsqueci(() => desenhar('entrar'), () => desenhar('colar')),
      colar: () => formColarLink(() => desenhar('definir'), () => desenhar('entrar')),
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

function formEntrar(onEntrou, aoEsquecer, aoColar) {
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
    el('button', { class: 'btn link-btn', onClick: aoColar }, 'Recebi um link por e-mail'),
  ]);
}

/**
 * Entrar colando o endereço do link recebido por e-mail.
 *
 * Existe por um motivo específico: o e-mail de recuperação do Supabase
 * aponta para o "Site URL" do projeto, que num projeto novo é
 * `http://localhost:3000`. Quem clica cai numa página de erro — mas o
 * token veio junto, no fragmento do endereço. Colando aqui, ele é
 * aproveitado.
 *
 * Isso não abre brecha: quem tem o link já tem acesso à conta, porque
 * recebeu o e-mail. O que não dá para fazer é o contrário — devolver o
 * link na tela para quem pedir —, aí bastaria pedir recuperação do e-mail
 * de outra pessoa.
 */
function formColarLink(aoEntrar, aoVoltar) {
  const campo = input({ type: 'text', placeholder: 'http://localhost:3000/#access_token=…' });
  const aviso = el('p', { class: 'caption negative' });

  const usar = async () => {
    aviso.textContent = '';
    if (!campo.value.includes('#')) {
      aviso.textContent = 'Cole o endereço inteiro, incluindo a parte depois do #.';
      return;
    }

    botao.disabled = true;
    botao.textContent = 'Verificando…';
    try {
      const sessao = await abrirSessaoDoFragmento(campo.value);
      if (!sessao) throw new Error('Não encontrei um token válido nesse endereço.');
      aoEntrar();
    } catch (error) {
      aviso.textContent = error.message;
      botao.disabled = false;
      botao.textContent = 'Entrar com o link';
    }
  };

  const botao = el('button', { class: 'btn primary wide', onClick: usar }, 'Entrar com o link');
  campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') usar(); });

  return card([
    el('strong', {}, 'Usar um link recebido por e-mail'),
    el('p', { class: 'caption' },
      'Se o link do e-mail abriu uma página de erro, copie o endereço inteiro da barra '
      + 'do navegador e cole aqui. O que importa está na parte depois do #.'),
    field('Endereço do link', campo),
    aviso,
    botao,
    el('button', { class: 'btn link-btn', onClick: aoVoltar }, 'Voltar'),
  ]);
}

function formEsqueci(aoVoltar, aoColar) {
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
    el('button', { class: 'btn link-btn', onClick: aoColar }, 'Já recebi o e-mail — colar o link'),
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
  const porTokenHash = await resgatarDaURL();
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
