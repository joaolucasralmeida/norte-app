/**
 * Gráfico de rosca.
 *
 * Feito à mão em SVG porque o app não tem build nem dependências — colar uma
 * biblioteca de gráficos traria React, um empacotador e algumas centenas de
 * kilobytes para desenhar meia dúzia de arcos.
 *
 * O desenho usa um truque: um círculo de raio 15,9155 tem circunferência 100,
 * então `stroke-dasharray` aceita a porcentagem diretamente, sem conta de
 * arco nenhuma. Cada fatia é um círculo inteiro com quase tudo tracejado
 * fora, girado até o ponto certo.
 *
 * Interação: passar o mouse ou tocar destaca a fatia e mostra o valor no
 * centro. O toque importa tanto quanto o mouse — o app vive num celular, e
 * ali não existe "passar por cima".
 */

import { el, svg } from './ui.js';
import { money, percent } from './format.js';

/** Raio cuja circunferência é exatamente 100. */
const RAIO = 15.915494;
const ESPESSURA = 7;
const ESPESSURA_ATIVA = 9.5;

/**
 * Fatias pequenas demais viram uma só.
 *
 * Abaixo disso o arco fica menor que a própria borda, impossível de acertar
 * com o dedo, e a legenda vira uma lista de centavos. Melhor uma linha
 * honesta de "Outras" do que sete fatias ilegíveis.
 */
const FATIA_MINIMA = 0.03;
const MAXIMO_DE_FATIAS = 6;

/** As duas maiores aparecem sempre, mesmo minúsculas. */
const SEMPRE_VISIVEIS = 2;

export function agruparFatias(slices) {
  // `slices` já vem da maior para a menor. O corte por tamanho sozinho tem um
  // buraco: num mês com trinta categorias pequenas, nenhuma alcançaria os 3%
  // e o gráfico inteiro viraria uma fatia chamada "Outras (30)" — verdadeira
  // e completamente inútil. As duas maiores passam sempre.
  const grandes = slices
    .slice(0, MAXIMO_DE_FATIAS)
    .filter((s, i) => i < SEMPRE_VISIVEIS || s.share >= FATIA_MINIMA);

  const resto = slices.filter((s) => !grandes.includes(s));
  if (resto.length === 0) return grandes;

  return [...grandes, {
    name: resto.length === 1 ? resto[0].name : `Outras (${resto.length})`,
    color: '#9CA3AF',
    icon: null,
    cents: resto.reduce((soma, s) => soma + s.cents, 0),
    share: resto.reduce((soma, s) => soma + s.share, 0),
  }];
}

/**
 * Monta a rosca. Devolve o elemento e deixa o estado de seleção por conta
 * dele — quem chama só precisa inserir no lugar certo.
 */
export function donutChart(slices, { total, rotulo = 'Gasto no mês' } = {}) {
  const fatias = agruparFatias(slices);
  const soma = total ?? fatias.reduce((s, f) => s + f.cents, 0);

  const centroTitulo = el('span', { class: 'donut-centro-rotulo' }, rotulo);
  const centroValor = el('strong', { class: 'donut-centro-valor' }, money(soma));
  const centro = el('div', { class: 'donut-centro' }, [centroTitulo, centroValor]);

  const arcos = [];
  let acumulado = 0;

  for (const [indice, fatia] of fatias.entries()) {
    const comprimento = fatia.share * 100;

    const arco = svg('circle', {
      class: 'donut-fatia',
      cx: 21, cy: 21, r: RAIO,
      fill: 'transparent',
      stroke: fatia.color,
      'stroke-width': ESPESSURA,
      'stroke-dasharray': `${comprimento} ${100 - comprimento}`,
      // O 25 desloca o início para o topo: sem ele o gráfico começaria às
      // 3 horas, e a maior fatia apareceria no lugar errado.
      'stroke-dashoffset': 25 - acumulado,
      tabindex: '0',
      role: 'button',
      'aria-label': `${fatia.name}: ${money(fatia.cents)}, ${percent(fatia.share)}`,
    });

    acumulado += comprimento;
    arcos.push({ arco, fatia, indice });
  }

  const desenho = svg('svg', {
    viewBox: '0 0 42 42',
    class: 'donut-svg',
    role: 'img',
    'aria-label': `Despesas por categoria, total de ${money(soma)}`,
  }, arcos.map((a) => a.arco));

  const legenda = el('div', { class: 'donut-legenda' });

  // ---------------------------------------------------------------------
  // Seleção
  // ---------------------------------------------------------------------

  let selecionada = null;

  const pintar = () => {
    for (const { arco, indice } of arcos) {
      const ativa = indice === selecionada;
      arco.setAttribute('stroke-width', ativa ? ESPESSURA_ATIVA : ESPESSURA);
      // Sem seleção, nada é apagado. Com seleção, as outras recuam — é o
      // que faz a escolhida saltar sem precisar de cor nova.
      arco.setAttribute('opacity', selecionada === null || ativa ? '1' : '0.35');
    }

    for (const linha of legenda.children) {
      linha.classList.toggle('ativa', Number(linha.dataset.indice) === selecionada);
    }

    const fatia = selecionada === null ? null : fatias[selecionada];
    centroTitulo.textContent = fatia ? fatia.name : rotulo;
    centroValor.textContent = fatia ? money(fatia.cents) : money(soma);
    centro.classList.toggle('selecionado', Boolean(fatia));
  };

  const selecionar = (indice) => {
    // Tocar na fatia já escolhida desfaz a seleção. Num celular não há como
    // "tirar o mouse de cima", então o próprio toque precisa ser o desfazer.
    selecionada = selecionada === indice ? null : indice;
    pintar();
  };

  for (const { arco, fatia, indice } of arcos) {
    arco.addEventListener('pointerenter', () => { selecionada = indice; pintar(); });
    arco.addEventListener('click', () => selecionar(indice));
    arco.addEventListener('focus', () => { selecionada = indice; pintar(); });
    arco.addEventListener('keydown', (evento) => {
      if (evento.key === 'Enter' || evento.key === ' ') { evento.preventDefault(); selecionar(indice); }
    });

    legenda.append(el('button', {
      class: 'donut-item',
      dataset: { indice: String(indice) },
      onClick: () => selecionar(indice),
      onPointerenter: () => { selecionada = indice; pintar(); },
    }, [
      el('span', { class: 'donut-ponto', style: { background: fatia.color } }),
      el('span', { class: 'donut-nome' }, fatia.icon ? `${fatia.icon} ${fatia.name}` : fatia.name),
      el('span', { class: 'donut-valor mono' }, money(fatia.cents)),
      el('span', { class: 'donut-share caption' }, percent(fatia.share)),
    ]));
  }

  const area = el('div', { class: 'donut-area' }, [desenho, centro]);

  // Sair da área inteira limpa a seleção. Só do SVG não bastaria: o
  // ponteiro passa pelo buraco do meio ao atravessar o gráfico, e o valor
  // piscaria de volta para o total no meio do movimento.
  area.addEventListener('pointerleave', () => { selecionada = null; pintar(); });
  legenda.addEventListener('pointerleave', () => { selecionada = null; pintar(); });

  pintar();
  return el('div', { class: 'donut' }, [area, legenda]);
}
