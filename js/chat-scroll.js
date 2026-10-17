/**
 * Rolagem da conversa com o assistente.
 *
 * Implementa o comportamento do "Message Scroller" do shadcn — que é React e
 * não roda aqui — nas regras que importam:
 *
 * · a pergunta nova sobe para perto do topo, deixando uma fresta da mensagem
 *   anterior visível, para a resposta ter espaço e a conversa não parecer
 *   recomeçar numa página em branco;
 * · a resposta cresce para dentro da tela em vez de empurrar tudo para cima;
 * · só acompanhamos o fim enquanto o leitor está no fim. Se ele rolou para
 *   cima, fica onde está e o texto continua chegando fora de vista;
 * · um botão avisa que há resposta chegando lá embaixo e leva de volta.
 *
 * A peça que faz isso funcionar é o espaçador no fim da lista. Sem ele, não
 * há como levar a última pergunta ao topo: o navegador não rola além do
 * conteúdo. O espaçador cede a altura que falta e encolhe conforme a
 * resposta cresce — quando ela enche a tela, ele some e a rolagem volta ao
 * normal.
 */

/** Tolerância para "está no fim": uma rolagem suave raramente para no pixel exato. */
const MARGEM_DO_FIM = 48;

/** Quanto da mensagem anterior continua aparecendo acima da pergunta nova. */
const FRESTA_PADRAO = 56;

export function criarRolagem(viewport, espacador, { fresta = FRESTA_PADRAO } = {}) {
  let seguindo = true;
  let aoMudar = () => {};

  /**
   * Para onde NÓS mandamos rolar, enquanto a animação não termina.
   *
   * Uma trava de um quadro não bastaria: `scroll-behavior: smooth` continua
   * emitindo eventos por uns 300ms depois da ordem, e cada um deles seria
   * lido como gesto do leitor — soltando o acompanhamento no meio de uma
   * resposta, que é justamente o que não pode acontecer. O alvo só é
   * esquecido quando a rolagem chega lá, ou quando desiste.
   */
  let alvo = null;
  let desistir = null;

  const noFim = () => (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= MARGEM_DO_FIM
  );

  /**
   * O botão aparece quando as duas coisas valem: o leitor saiu do fim E há
   * conteúdo abaixo dele.
   *
   * Só a intenção não basta — parado no meio da conversa, com a resposta
   * crescendo lá embaixo, nenhum evento de rolagem acontece e ele nunca
   * saberia. Só a geometria também não: enquanto acompanhamos, a rolagem
   * suave leva uns instantes para chegar ao fim, e o botão piscaria a cada
   * pedaço de texto.
   */
  const avisar = () => {
    const conteudoAbaixo = !seguindo && !noFim();
    // Espelhado no elemento: serve de gancho para CSS e deixa o estado
    // visível ao inspecionar a página, em vez de preso num fechamento.
    viewport.dataset.seguindo = String(seguindo);
    viewport.dataset.conteudoAbaixo = String(conteudoAbaixo);
    aoMudar(conteudoAbaixo);
  };

  /**
   * Qualquer gesto do leitor decide se continuamos acompanhando.
   *
   * Rolar não é o único sinal: teclado e arrasto da barra também contam, e
   * é por isso que escutamos o evento `scroll` em vez de só `wheel`. O que
   * não pode contar é a rolagem que nós mesmos provocamos — daí a trava.
   */
  viewport.addEventListener('scroll', () => {
    if (alvo !== null) {
      // Chegou onde mandamos: a animação acabou e a escuta volta ao leitor.
      if (Math.abs(viewport.scrollTop - alvo) <= 2) encerrarAlvo();
      return;
    }
    const antes = seguindo;
    seguindo = noFim();
    if (antes !== seguindo) avisar();
  }, { passive: true });

  function encerrarAlvo() {
    alvo = null;
    clearTimeout(desistir);
  }

  /**
   * `scrollTo` com a suavidade escolhida na hora, em vez de `scrollTop` com
   * `scroll-behavior` fixo no CSS.
   *
   * Acompanhar o texto que chega precisa ser instantâneo: cada pedaço novo
   * reiniciaria a animação suave, que por isso nunca chegaria ao fim — o
   * texto cresce e a rolagem fica para trás. Suave fica para os dois casos
   * em que o leitor precisa perceber o movimento: ancorar uma pergunta nova
   * e voltar ao fim pelo botão.
   */
  const rolarPara = (topo, suave = false) => {
    alvo = topo;
    clearTimeout(desistir);
    // Rede de segurança: se a rolagem for interrompida (o leitor tocou na
    // tela no meio), o alvo nunca seria alcançado e os gestos dele ficariam
    // ignorados para sempre.
    desistir = setTimeout(encerrarAlvo, 700);
    // 'instant', e nao 'auto': 'auto' manda o navegador usar o valor de
    // `scroll-behavior` do CSS — que ja foi `smooth` aqui. A rolagem saia
    // animada mesmo quando pedimos que nao fosse, e cada pedaco de texto
    // reiniciava a animacao, que nunca chegava ao fim.
    viewport.scrollTo({ top: topo, behavior: suave ? 'smooth' : 'instant' });
    if (!suave) encerrarAlvo();
  };

  const fim = () => viewport.scrollHeight - viewport.clientHeight;

  return {
    get seguindo() { return seguindo; },

    /** Reserva espaço para que `elemento` consiga chegar ao topo da tela. */
    reservarEspacoPara(elemento) {
      if (!elemento) { espacador.style.height = '0px'; return; }
      const alturaDaVolta = viewport.scrollHeight
        - espacador.offsetHeight
        - elemento.offsetTop;
      const falta = viewport.clientHeight - fresta - alturaDaVolta;
      espacador.style.height = `${Math.max(0, falta)}px`;
    },

    /** Leva `elemento` para perto do topo, deixando a fresta acima dele. */
    ancorar(elemento) {
      if (!elemento) return;
      this.reservarEspacoPara(elemento);
      rolarPara(Math.max(0, elemento.offsetTop - fresta), true);
      seguindo = true;
      avisar();
    },

    /** Acompanha o fim — e só enquanto o leitor estiver acompanhando. */
    acompanhar(ancora) {
      if (ancora) this.reservarEspacoPara(ancora);
      if (seguindo) rolarPara(fim());
      // Avisa nos dois casos: mesmo acompanhando, a rolagem suave leva um
      // tempo até chegar, e nesse intervalo há conteúdo fora de vista.
      avisar();
    },

    /** Volta ao fim e retoma o acompanhamento. */
    irParaOFim() {
      rolarPara(fim(), true);
      seguindo = true;
      avisar();
    },

    /** Avisado quando aparece (ou some) conteúdo fora de vista abaixo. */
    quandoMudar(callback) { aoMudar = callback; avisar(); },
  };
}
