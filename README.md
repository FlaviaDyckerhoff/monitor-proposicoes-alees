# 🏛️ Monitor Proposições ES — ALES

Monitora automaticamente o portal da Assembleia Legislativa do Espírito Santo e envia email quando há proposições novas. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

---

## Como funciona

1. GitHub Actions roda o script nos horários configurados
2. O script acessa o portal `www3.al.es.gov.br/spl/consulta-producao.aspx`
3. Navega pelas páginas via postback ASP.NET UpdatePanel
4. Compara os IDs encontrados com os já registrados no `estado.json`
5. Se há proposições novas → envia email organizado por tipo
6. Salva o estado atualizado no repositório

---

## Estrutura do repositório

```
monitor-proposicoes-es/
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
2. Nome: `monitor-proposicoes-es` | Visibilidade: **Private**
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

### PARTE 5 — Testar

1. **Actions → Monitor Proposições ES → Run workflow → Run workflow**
2. Aguarde ~30-60 segundos (o portal é lento)
3. Verde = funcionou

**Primeiro run:** envia email com as 500 proposições mais recentes e salva o estado.
**Runs seguintes:** só notifica se houver novidades.

---

## Comportamento de paginação

- **Primeiro run:** busca até 10 páginas × 50 itens = 500 proposições (backlog inicial)
- **Runs seguintes:** para de paginar assim que encontra uma página sem novidades
- Isso garante que runs normais fazem 1-3 chamadas ao portal

---

## Nota técnica

O portal usa ASP.NET WebForms com UpdatePanel. A paginação é feita via POST com tokens `__VIEWSTATE` e `__EVENTVALIDATION` renovados a cada resposta. O script extrai automaticamente esses tokens e os encadeia entre páginas.

O portal tem Cloudflare Turnstile configurado como `interaction-only`, o que significa que só bloqueia se detectar comportamento suspeito. O script usa delays entre requisições (1-2 segundos) para parecer tráfego normal.

---

## Resetar o estado

Para forçar reenvio de todas as proposições:

1. No repositório, clique em `estado.json` → lápis
2. Substitua por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```
3. Commit → rode manualmente

---

## Problemas comuns

**Erro de timeout ou conexão recusada**
→ O portal pode estar fora do ar. Tente acessar `https://www3.al.es.gov.br/spl/consulta-producao.aspx?ano=2026&ano_proposicao=2026` no browser.

**"0 proposições novas" mas deveria ter**
→ Resetar o `estado.json` e rodar novamente.

**Cloudflare bloqueou o IP**
→ Se aparecer no log erro 403 ou conteúdo HTML de challenge, o IP do GitHub Actions foi bloqueado. Solução: migrar para VPS com self-hosted runner (`runs-on: self-hosted` no monitor.yml).

**Erro de autenticação Gmail**
→ Verifique se `EMAIL_SENHA` foi colado sem espaços.
