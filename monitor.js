const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const URL_BASE = 'https://www3.al.es.gov.br/spl/consulta-producao.aspx';
const ANO = new Date().getFullYear();
const ITENS_POR_PAGINA = 50;
const MAX_PAGINAS_PRIMEIRO_RUN = 10; // 500 proposições no backlog inicial

// ─── Estado ──────────────────────────────────────────────────────────────────

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────

function extrairCampo(html, regex) {
  const m = html.match(regex);
  return m ? m[1].trim() : null;
}

function extrairViewState(html) {
  // Extrai __VIEWSTATE do HTML inicial
  const m = html.match(/id="__VIEWSTATE"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

function extrairViewStateGenerator(html) {
  const m = html.match(/id="__VIEWSTATEGENERATOR"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

function extrairEventValidation(html) {
  const m = html.match(/id="__EVENTVALIDATION"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

// Extrai campos do UpdatePanel (resposta pipe-delimitada)
function extrairDoCampoUpdatePanel(resposta, nomeCampo) {
  // Formato: N|hiddenField|CAMPO|VALOR
  const regex = new RegExp(`\\d+\\|hiddenField\\|${nomeCampo}\\|([^|]+(?:\\|(?!\\d+\\|)[^|]+)*)`);
  // Estratégia mais robusta: achar o campo e pegar tudo até o próximo pipe-número
  const partes = resposta.split('|');
  for (let i = 0; i < partes.length - 3; i++) {
    if (partes[i + 1] === 'hiddenField' && partes[i + 2] === nomeCampo) {
      return partes[i + 3];
    }
  }
  return null;
}

function extrairViewStateDeResposta(resposta) {
  return extrairDoCampoUpdatePanel(resposta, '__VIEWSTATE');
}

function extrairEventValidationDeResposta(resposta) {
  return extrairDoCampoUpdatePanel(resposta, '__EVENTVALIDATION');
}

// Extrai o HTML do UpdatePanel da resposta pipe-delimitada
function extrairHtmlUpdatePanel(resposta) {
  // Formato: N|updatePanel|ContentPlaceHolder1_upp_consultaProducao|HTML...
  const marker = '|updatePanel|ContentPlaceHolder1_upp_consultaProducao|';
  const idx = resposta.indexOf(marker);
  if (idx === -1) return null;
  const inicio = idx + marker.length;
  // O HTML termina antes do próximo bloco pipe
  // Procura pelo padrão |N|tipo| após o HTML
  const resto = resposta.substring(inicio);
  // Pega o tamanho declarado antes do marcador
  const tamanhoStr = resposta.substring(0, idx).split('|').pop();
  const tamanho = parseInt(tamanhoStr);
  if (!isNaN(tamanho)) {
    return resto.substring(0, tamanho);
  }
  // Fallback: pega até o fim
  return resto;
}

// Parseia proposições do HTML do UpdatePanel
function parseProposicoes(html) {
  const proposicoes = [];
  // Cada proposição está em <div class="kt-widget5__item ...">
  const blocos = html.split('kt-widget5__item');
  
  for (let i = 1; i < blocos.length; i++) {
    const bloco = blocos[i];
    
    // ID: <span class="kt-font-info">480411</span> após "ID:"
    const idMatch = bloco.match(/ID:<\/span>\s*<span[^>]*>(\d+)<\/span>/);
    if (!idMatch) continue;
    const id = idMatch[1];

    // Título/tipo: <a ... class="kt-widget5__title">Indicação n° 950/2026</a>
    const tituloMatch = bloco.match(/kt-widget5__title[^>]*>\s*([^<]+?)\s*<\/a>/);
    const titulo = tituloMatch ? tituloMatch[1].trim() : '-';

    // Tipo e número do título (ex: "Indicação n° 950/2026")
    const tipoNumMatch = titulo.match(/^(.+?)\s+n[°º]\s*(\d+)\/\d+/);
    const tipo = tipoNumMatch ? tipoNumMatch[1].trim() : titulo;
    const numero = tipoNumMatch ? tipoNumMatch[2] : '-';

    // Ementa: <a ... class="kt-widget5__desc">...</a>
    const ementaMatch = bloco.match(/kt-widget5__desc[^>]*>\s*([\s\S]+?)\s*<\/a>/);
    const ementa = ementaMatch
      ? ementaMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 200)
      : '-';

    // Data
    const dataMatch = bloco.match(/Data:<\/span>\s*<span[^>]*>([^<]+)<\/span>/);
    const data = dataMatch ? dataMatch[1].trim() : '-';

    // Autor
    const autorMatch = bloco.match(/Autor\(es\) da Proposição:<\/span>\s*<span[^>]*>([\s\S]+?)<\/span>/);
    let autor = '-';
    if (autorMatch) {
      autor = autorMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    }

    // Processo
    const processoMatch = bloco.match(/Processo N°:<\/span>\s*<a[^>]*>([^<]+)<\/a>/);
    const processo = processoMatch ? processoMatch[1].trim() : '-';

    proposicoes.push({ id, tipo, numero, ementa, data, autor, processo });
  }

  return proposicoes;
}

// ─── Requisições ─────────────────────────────────────────────────────────────

const HEADERS_BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function carregarPaginaInicial() {
  const url = `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`;
  console.log(`📥 Carregando página inicial: ${url}`);
  
  const resp = await fetch(url, {
    headers: { ...HEADERS_BASE, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });

  if (!resp.ok) {
    throw new Error(`Erro HTTP ${resp.status} na página inicial`);
  }

  const html = await resp.text();
  
  // Extrai tokens ASP.NET
  const viewState = extrairViewState(html);
  const viewStateGen = extrairViewStateGenerator(html);
  const eventValidation = extrairEventValidation(html);

  if (!viewState) {
    throw new Error('Não foi possível extrair __VIEWSTATE da página inicial');
  }

  console.log(`✅ Página inicial carregada. ViewState: ${viewState.substring(0, 30)}...`);

  // Parseia proposições da página 1
  const proposicoes = parseProposicoes(html);
  console.log(`📊 Página 1: ${proposicoes.length} proposições`);

  // Extrai total de proposições
  const totalMatch = html.match(/Localizada\(s\)\s*<strong>(\d+)<\/strong>/);
  const total = totalMatch ? parseInt(totalMatch[1]) : 0;
  const totalPaginas = Math.ceil(total / ITENS_POR_PAGINA);
  console.log(`📋 Total: ${total} proposições, ~${totalPaginas} páginas (com ${ITENS_POR_PAGINA} itens/página)`);

  // Cookies da sessão
  const cookies = resp.headers.get('set-cookie') || '';

  return { viewState, viewStateGen, eventValidation, proposicoesPag1: proposicoes, total, totalPaginas, cookies, htmlInicial: html };
}

async function mudarPara50Itens(estado) {
  // Primeiro muda para 50 itens por página via postback do select
  const { viewState, viewStateGen, eventValidation, cookies } = estado;

  const body = new URLSearchParams({
    'ctl00$scm_principal': 'ctl00$ContentPlaceHolder1$upp_consultaProducao|ctl00$ContentPlaceHolder1$ddl_ItensExibidos',
    '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$ddl_ItensExibidos',
    '__EVENTARGUMENT': '',
    '__LASTFOCUS': '',
    '__VIEWSTATE': viewState,
    '__VIEWSTATEGENERATOR': viewStateGen || '8AC33856',
    '__EVENTVALIDATION': eventValidation,
    'ctl00$ContentPlaceHolder1$id_proposicao': '123456',
    'ctl00$ContentPlaceHolder1$txt_nome': '',
    'ctl00$ContentPlaceHolder1$txt_email': '',
    'ctl00$ContentPlaceHolder1$txt_email_confirmacao': '',
    'ctl00$ContentPlaceHolder1$ddl_ItensExibidos': String(ITENS_POR_PAGINA),
    '__ASYNCPOST': 'true',
  });

  const resp = await fetch(`${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`, {
    method: 'POST',
    headers: {
      ...HEADERS_BASE,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-MicrosoftAjax': 'Delta=true',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`,
      ...(cookies ? { 'Cookie': cookies } : {}),
    },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`Erro HTTP ${resp.status} ao mudar itens por página`);

  const texto = await resp.text();
  const novoViewState = extrairViewStateDeResposta(texto);
  const novoEventValidation = extrairEventValidationDeResposta(texto);
  const htmlPanel = extrairHtmlUpdatePanel(texto);
  const proposicoes = htmlPanel ? parseProposicoes(htmlPanel) : [];

  console.log(`✅ Mudou para ${ITENS_POR_PAGINA} itens/página. Proposições: ${proposicoes.length}`);

  return {
    viewState: novoViewState || viewState,
    viewStateGen: viewStateGen,
    eventValidation: novoEventValidation || eventValidation,
    proposicoes,
    cookies,
  };
}

async function buscarPagina(numeroPagina, estadoAtual) {
  const { viewState, viewStateGen, eventValidation, cookies } = estadoAtual;
  
  // O __EVENTTARGET para página N é: ctl00$ContentPlaceHolder1$rptPaging$ctl{NN}$lbPaging
  // Páginas são 0-indexed no controle: ctl00=pág1, ctl01=pág2, etc.
  const idx = String(numeroPagina - 1).padStart(2, '0');
  const eventoTarget = `ctl00$ContentPlaceHolder1$rptPaging$ctl${idx}$lbPaging`;

  const body = new URLSearchParams({
    'ctl00$scm_principal': `ctl00$ContentPlaceHolder1$upp_consultaProducao|${eventoTarget}`,
    '__EVENTTARGET': eventoTarget,
    '__EVENTARGUMENT': '',
    '__LASTFOCUS': '',
    '__VIEWSTATE': viewState,
    '__VIEWSTATEGENERATOR': viewStateGen || '8AC33856',
    '__EVENTVALIDATION': eventValidation,
    'ctl00$ContentPlaceHolder1$id_proposicao': '123456',
    'ctl00$ContentPlaceHolder1$txt_nome': '',
    'ctl00$ContentPlaceHolder1$txt_email': '',
    'ctl00$ContentPlaceHolder1$txt_email_confirmacao': '',
    'ctl00$ContentPlaceHolder1$ddl_ItensExibidos': String(ITENS_POR_PAGINA),
    '__ASYNCPOST': 'true',
  });

  const resp = await fetch(`${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`, {
    method: 'POST',
    headers: {
      ...HEADERS_BASE,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-MicrosoftAjax': 'Delta=true',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`,
      ...(cookies ? { 'Cookie': cookies } : {}),
    },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`Erro HTTP ${resp.status} na página ${numeroPagina}`);

  const texto = await resp.text();

  // Atualiza tokens para próxima requisição
  const novoViewState = extrairViewStateDeResposta(texto);
  const novoEventValidation = extrairEventValidationDeResposta(texto);
  const htmlPanel = extrairHtmlUpdatePanel(texto);
  const proposicoes = htmlPanel ? parseProposicoes(htmlPanel) : [];

  return {
    viewState: novoViewState || viewState,
    viewStateGen,
    eventValidation: novoEventValidation || eventValidation,
    proposicoes,
    cookies,
  };
}

// ─── Lógica principal ────────────────────────────────────────────────────────

async function buscarProposicoes(idsVistos, primeiroRun) {
  // 1. Carrega página inicial (10 itens/pág)
  const inicial = await carregarPaginaInicial();
  await sleep(1500);

  // 2. Muda para 50 itens por página
  let estadoAtual = await mudarPara50Itens(inicial);
  await sleep(1500);

  const todasProposicoes = [...estadoAtual.proposicoes];
  
  // Se não é primeiro run, verifica se já viu todas da primeira página
  if (!primeiroRun) {
    const novasNaPag1 = estadoAtual.proposicoes.filter(p => !idsVistos.has(p.id));
    if (novasNaPag1.length === 0) {
      console.log('✅ Nenhuma novidade na primeira página. Parando.');
      return todasProposicoes.filter(p => !idsVistos.has(p.id));
    }
  }

  // 3. Itera pelas próximas páginas
  // No primeiro run: até MAX_PAGINAS, nos demais: para quando não houver novidades
  const totalPaginas = Math.ceil(inicial.total / ITENS_POR_PAGINA);
  const maxPag = primeiroRun ? Math.min(MAX_PAGINAS_PRIMEIRO_RUN, totalPaginas) : totalPaginas;

  for (let pag = 2; pag <= maxPag; pag++) {
    console.log(`📄 Buscando página ${pag}/${maxPag}...`);
    await sleep(2000);

    try {
      estadoAtual = await buscarPagina(pag, estadoAtual);
      console.log(`   → ${estadoAtual.proposicoes.length} proposições`);
      todasProposicoes.push(...estadoAtual.proposicoes);

      // Se não é primeiro run, para quando não houver novidades na página
      if (!primeiroRun) {
        const novas = estadoAtual.proposicoes.filter(p => !idsVistos.has(p.id));
        if (novas.length === 0) {
          console.log(`✅ Sem novidades na página ${pag}. Parando.`);
          break;
        }
      }
    } catch (err) {
      console.error(`❌ Erro na página ${pag}: ${err.message}`);
      break;
    }
  }

  return todasProposicoes.filter(p => !idsVistos.has(p.id));
}

// ─── Email ───────────────────────────────────────────────────────────────────

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const linhas = Object.keys(porTipo).sort().map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo].map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.tipo || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.numero || '-'}/${ANO}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data ? p.data.substring(0, 16) : '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa || '-'}</td>
      </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ ALES-ES — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left">Tipo</th>
            <th style="padding:10px;text-align:left">Número</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://www3.al.es.gov.br/spl/consulta-producao.aspx?ano=${ANO}&ano_proposicao=${ANO}">Portal ALES</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor ALES-ES" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ ALES-ES: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

(async () => {
  console.log('🚀 Iniciando monitor ALES-ES...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas.map(String));
  const primeiroRun = idsVistos.size === 0;

  console.log(`📁 IDs já vistos: ${idsVistos.size} | Primeiro run: ${primeiroRun}`);

  try {
    const novas = await buscarProposicoes(idsVistos, primeiroRun);
    console.log(`🆕 Proposições novas: ${novas.length}`);

    if (novas.length > 0) {
      novas.sort((a, b) => {
        if (a.tipo < b.tipo) return -1;
        if (a.tipo > b.tipo) return 1;
        return (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0);
      });

      await enviarEmail(novas);
      novas.forEach(p => idsVistos.add(String(p.id)));
      estado.proposicoes_vistas = Array.from(idsVistos);
    } else {
      console.log('✅ Sem novidades. Nada a enviar.');
    }

    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);

  } catch (err) {
    console.error(`❌ Erro fatal: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
})();
