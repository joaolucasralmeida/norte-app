# Banco do Norte no Supabase

Projeto **norte** · `jkzsucknezplwedrigjo` · região sa-east-1 (São Paulo) · plano gratuito.

`https://jkzsucknezplwedrigjo.supabase.co`

Tudo abaixo **já está aplicado**. Os arquivos ficam aqui como histórico e para refazer o projeto do zero se um dia precisar.

| Arquivo | O que faz |
|---|---|
| `01_schema.sql` | Tabelas, chaves, restrições e índices |
| `02_rls.sql` | Row Level Security — é o que separa os dados de uma pessoa dos de outra |
| `03_sync.sql` | `updated_at` e `deleted_at`, que fazem dois aparelhos conversarem |
| `functions/convidar/` | Edge Function que convida gente por e-mail |

---

## ⚠ Duas coisas que só você pode fazer

Não existe ferramenta de configuração de autenticação no conector — essas duas ficaram pendentes.

### 1. Endereços de retorno (senão o link do convite não funciona)

**Authentication → URL Configuration:**

- **Site URL**: `https://joaolucasralmeida.github.io/norte-app/`
- **Redirect URLs**: `https://joaolucasralmeida.github.io/norte-app/**`

O padrão de um projeto novo é `http://localhost:3000`. Enquanto estiver assim, quem clicar no convite cai numa página que não existe.

### 2. Fechar o cadastro aberto

**Authentication → Providers → Email → desligue "Enable sign-ups".**

Conferi: está **ligado** (`disable_signup: false`). Qualquer pessoa na internet pode criar uma conta neste projeto agora. A RLS garante que ela veria apenas os próprios dados — vazios —, mas não há motivo para deixar a porta aberta. Com isso desligado, só entra quem for convidado.

---

## Quem pode o quê

| Papel | Pode |
|---|---|
| `admin` | Tudo o que um membro pode, mais convidar pessoas e ver a lista delas |
| `member` | Só os próprios lançamentos, metas, anotações e agenda |

Ninguém vê dado de ninguém, nem o admin. O papel controla **administração**, não acesso a dados.

`joaolucasralmeida@icloud.com` é admin. Foi criado pela janela de primeiro acesso da função `convidar`, que se fecha sozinha e para sempre assim que existe um usuário — já está fechada (responde 403).

---

## Como convidar alguém

Pelo app: **Configurações → Pessoas**. O cartão só aparece para administradores.

A pessoa recebe um link, escolhe a própria senha, e entra como `member`. **Nenhuma senha é criada, transmitida ou guardada em lugar nenhum.**

> O plano gratuito envia **2 e-mails por hora**. Se um convite não sair, é isso — espere e tente de novo.

Para promover alguém a admin, só por SQL:

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'pessoa@exemplo.com');
```

Não há botão para isso de propósito: a coluna `role` é revogada para o cliente, então nem um admin consegue promover outro pelo navegador.

---

## Como a sincronização funciona

O app é **local primeiro**: o IndexedDB do navegador continua sendo de onde ele lê para desenhar a tela, e o Supabase é onde os dados moram. Sem isso o app pararia de abrir sem internet — e ele vive na tela de início de um celular.

A cada abertura, e sempre que a conexão volta:

1. **puxa** o que mudou no servidor desde a última vez;
2. **empurra** o que foi criado, alterado ou apagado aqui.

**Conflito**: vence o mais recente, pelo `updated_at` que o banco carimba. Editar a mesma meta nos dois aparelhos no mesmo minuto faz uma das edições sumir inteira — não há mesclagem campo a campo.

**Exclusão** é marcação (`deleted_at`), não remoção. Apagar de verdade faria o registro voltar: o outro aparelho, que nunca soube da exclusão, reenviaria na sincronização seguinte.

**Sair da conta apaga a cópia local.** Num computador compartilhado, deixá-la significaria que o próximo a abrir o app veria tudo sem senha. O servidor fica intacto.

---

## Segurança

- **RLS em todas as 11 tabelas**, uma política por tabela. Verificado contra a API real: sem login, leitura devolve vazio e escrita devolve 401.
- **A chave no app é pública por desenho** e não dá acesso a nada sozinha. A `service_role`, que ignora a RLS, existe apenas dentro da Edge Function.
- **Funções `SECURITY DEFINER` tiveram o `EXECUTE` revogado.** O PostgREST as publicava em `/rest/v1/rpc/...`, onde qualquer visitante poderia chamá-las com privilégios elevados. Hoje respondem 404.
- **`is_admin()` tem `search_path` fixo**, senão alguém poderia criar uma tabela `profiles` num schema próprio e fazer a função responder "sim" para qualquer um.
- **A função `convidar` só aceita chamadas de `https://joaolucasralmeida.github.io`** e confere o papel no servidor.

O verificador do Supabase não aponta nenhum alerta (`get_advisors`, categoria segurança).

---

## Por que não há integração com o GitHub

A integração que sincroniza migrações do repositório custa **US$ 0,0134/hora**, cerca de **US$ 10/mês** — ela cria um banco de pré-visualização por branch. Como o projeto é para ser gratuito, ficou de fora.

O que resta é o essencial, de graça: as migrações estão versionadas nesta pasta, junto com o resto do código. Para aplicar mudanças futuras, rode o SQL no painel ou peça para o assistente aplicar pelo conector.
