# 🏛️ Monitor Proposições ES — ALES

Monitora automaticamente o portal da Assembleia Legislativa do Espírito Santo e envia email quando há proposições novas. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

> **Atenção:** este monitor roda em **self-hosted runner** (VPS própria), não nos servidores do GitHub. O portal da ALES bloqueia IPs de datacenter como os da AWS/GitHub.

---

## Como funciona

1. GitHub Actions dispara o job nos horários configurados, usando o runner instalado na VPS
2. O script acessa `www3.al.es.gov.br/spl/consulta-producao.aspx`
3. Navega pelas páginas via postback ASP.NET UpdatePanel
4. Compara os IDs encontrados com os já registrados no `estado.json`
5. Se há proposições novas → envia email organizado por tipo
6. Salva o estado atualizado no repositório

---

## Estrutura do repositório

```
monitor-proposicoes-alees/
├── monitor.js                      # Script principal
├── package.json                    # Dependências (nodemailer)
├── estado.json                     # Estado salvo automaticamente
├── README.md
└── .github/
    └── workflows/
        └── monitor.yml
```

---

## Setup

### PARTE 1 — Gmail (App Password)

1. Acesse [myaccount.google.com/security](https://myaccount.google.com/security)
2. Ative **Verificação em duas etapas** se ainda não estiver ativa
3. Busque **"Senhas de app"** → Criar → nome: `monitor-ales-es`
4. Copie a senha de **16 letras** (aparece só uma vez)

> Se já tem App Password de outro monitor, pode reutilizar a mesma.

---

### PARTE 2 — Criar repositório no GitHub

1. [github.com](https://github.com) → **+ → New repository**
2. Nome: `monitor-proposicoes-alees` | Visibilidade: **Private**
3. Clique em **Create repository**

---

### PARTE 3 — Upload dos arquivos

1. Na página do repositório: **"uploading an existing file"**
2. Faça upload de: `monitor.js`, `package.json`, `README.md`
3. Commit changes

4. Para o workflow: **Add file → Create new file**
5. Nome: `.github/workflows/monitor.yml`
6. Cole o conteúdo do `monitor.yml` e commit

---

### PARTE 4 — Secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail |
| `EMAIL_SENHA` | App Password de 16 letras (sem espaços) |
| `EMAIL_DESTINO` | email de destino dos alertas |

---

### PARTE 5 — Registrar o self-hosted runner

1. No repositório: **Settings → Actions → Runners → New self-hosted runner**
2. Selecione: **Linux → x64**
3. Execute os comandos na VPS:

```bash
mkdir actions-runner-alees && cd actions-runner-alees

# Baixar e extrair (use o comando exato gerado pelo GitHub)
curl -o actions-runner-linux-x64-X.X.X.tar.gz -L https://github.com/actions/runner/releases/...
tar xzf ./actions-runner-linux-x64-X.X.X.tar.gz

# Configurar com o token gerado pelo GitHub
./config.sh --url https://github.com/SEU_USUARIO/monitor-proposicoes-alees --token TOKEN_GERADO

# Instalar como serviço
sudo ./svc.sh install
sudo ./svc.sh start
```

4. O runner deve aparecer com status **Idle** (verde) no GitHub

---

### PARTE 6 — Testar

1. **Actions → Monitor Proposições ES → Run workflow → Run workflow**
2. Aguarde ~1-2 minutos
3. Verde = funcionou

**Primeiro run:** envia email com as 500 proposições mais recentes e salva o estado.
**Runs seguintes:** só notifica se houver novidades.

---

## Comportamento de paginação

- **Primeiro run:** busca até 10 páginas × 50 itens = 500 proposições (backlog inicial)
- **Runs seguintes:** para de paginar assim que encontra uma página sem novidades
- Runs normais fazem 1-3 chamadas ao portal

---

## Notas técnicas

### ASP.NET UpdatePanel
O portal usa ASP.NET WebForms com UpdatePanel. A paginação é feita via POST com tokens `__VIEWSTATE` e `__EVENTVALIDATION` renovados a cada resposta. O script extrai automaticamente esses tokens e os encadeia entre páginas.

### Problema de SSL — certificado com cadeia incompleta
O servidor `www3.al.es.gov.br` usa um certificado SSL cuja cadeia intermediária **não é enviada pelo servidor** no handshake TLS. Isso faz com que o Node.js (via `undici`) recuse a conexão com `unable to verify the first certificate`, mesmo que o certificado seja válido.

**Solução aplicada:** a primeira linha do `monitor.js` define:
```javascript
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
```
Isso desativa a verificação de certificado SSL no Node.js para todas as requisições daquele processo.

**Impacto de segurança:** baixo — o monitor só faz requisições GET para um portal público, sem transmitir credenciais para esse servidor.

**O que foi tentado antes e não funcionou:**
- `NODE_EXTRA_CA_CERTS` — o `undici` não respeita essa variável
- `NODE_TLS_REJECT_UNAUTHORIZED` via `env` no workflow — aplicado tarde demais no ciclo de inicialização
- `update-ca-certificates` e adição manual do certificado — resolve o `curl` do sistema mas não o Node.js
- A solução definitiva seria o servidor da ALES corrigir a cadeia de certificados no lado deles

---

## Resetar o estado

Para forçar reenvio de todas as proposições:

1. No repositório, clique em `estado.json` → lápis (✏️)
2. Substitua por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```
3. Commit → rode manualmente

---

## Problemas comuns

**Runner aparece como Offline no GitHub**
→ O serviço na VPS parou. Conecte na VPS e execute:
```bash
cd actions-runner-alees
sudo ./svc.sh status
sudo ./svc.sh start
```

**`fetch failed` ou erro de conexão**
→ Teste na VPS:
```bash
curl -I "https://www3.al.es.gov.br/spl/consulta-producao.aspx?ano=2026&ano_proposicao=2026"
```
Se retornar `HTTP/2 200`, o problema é SSL no Node — verifique se a linha `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` está na primeira linha do `monitor.js`.

**"0 proposições novas" mas deveria ter**
→ Resetar o `estado.json` e rodar novamente.

**Erro de autenticação Gmail**
→ Verifique se `EMAIL_SENHA` foi colado sem espaços.
