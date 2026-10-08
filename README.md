# Norte

App de finanças pessoais que roda no navegador e instala na tela de início do iPhone.

**Contas e lançamentos · compras parceladas · metas de compra com aportes · diário · calendário**

Seus dados ficam **somente no seu aparelho**, no armazenamento do navegador. Não há servidor, não há conta, não há nuvem.

---

## Instalar no iPhone

1. Abra o endereço deste site **no Safari**.
2. Toque em **Compartilhar** (quadrado com seta para cima).
3. **Adicionar à Tela de Início** → **Adicionar**.

Abrindo pelo ícone, o app ocupa a tela inteira, sem a barra do Safari, e funciona sem internet.

> Se aparecer a barra de endereço ao abrir pelo ícone, foi criado um atalho comum. Apague e repita a partir do Safari — Chrome e outros navegadores no iOS não instalam web apps.

---

## Faça backup

Esta é a parte que não dá para pular.

Como não existe servidor, **tudo vive no armazenamento do Safari deste aparelho**. Apagar o ícone, limpar os dados do site ou trocar de celular leva junto os seus lançamentos.

**Configurações → Exportar backup**, uma vez por mês. São poucos KB. O app começa a te lembrar depois de 14 dias sem backup.

Para restaurar: **Configurações → Restaurar** e escolha o arquivo `.json`.

---

## Lembretes de parcela

Um site não consegue notificar de forma confiável com o app fechado. Em vez de tentar, o Norte entrega os vencimentos ao **app Calendário do iPhone**, que é quem dispara os alertas — no horário certo e de graça.

Aba **Calendário** → **Enviar eventos para o Calendário** → escolha "Calendário" na folha de compartilhamento.

Reimportar não duplica: cada evento tem identificador fixo, então o Calendário atualiza o que já existe.

---

## Assistente de IA (opcional)

O chat de pesquisa de preços precisa de um servidor próprio e fica desligado por padrão. Sem ele, todo o resto funciona normalmente e offline.

---

## Para desenvolvedores

Sem build, sem npm, sem dependências: HTML, CSS e JavaScript que o navegador lê direto. Para testar localmente, sirva a pasta por HTTP — abrir o `index.html` com duplo clique não funciona, porque `file://` bloqueia módulos e service worker.

```
index.html              casca e barra de abas
manifest.webmanifest    nome, ícone, modo tela cheia
sw.js                   cache offline
css/app.css             estilo, claro e escuro
js/domain.js            parcelamento, saldos e metas (funções puras)
js/db.js                IndexedDB
js/store.js             estado e escrita
js/ics.js               geração do arquivo de calendário
js/backup.js            exportar e restaurar
js/screens/             uma tela por arquivo
```

Publicou uma atualização e o app continua antigo? Feche-o na multitarefa e abra de novo, ou incremente `VERSION` em `sw.js`.
