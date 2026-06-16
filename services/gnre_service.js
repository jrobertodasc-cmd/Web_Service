// services/gnre_service.js
// Comunicação SOAP com a SEFAZ e emissão de guias GNRE

const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const parserService = require('./parser_service');

// URLs SEFAZ PE (Ambientes homologação e produção)
const URLS_SEFAZ = {
    producao: {
        recepcao: "https://www.gnre.pe.gov.br/gnreWS/services/GnreLoteRecepcao",
        consulta: "https://www.gnre.pe.gov.br/gnreWS/services/GnreResultadoLote"
    },
    simulado: {
        recepcao: "https://www.testegnre.pe.gov.br/gnreWS/services/GnreLoteRecepcao",
        consulta: "https://www.testegnre.pe.gov.br/gnreWS/services/GnreResultadoLote"
    }
};

/**
 * Cria o agente HTTPS com certificado digital para autenticação mTLS
 */
function createHttpsAgent({ pfxBuffer, passphrase }) {
    if (!pfxBuffer) {
        throw new Error("Certificado PFX ausente para inicialização do agente mTLS.");
    }
    return new https.Agent({
        pfx: pfxBuffer,
        passphrase: passphrase,
        keepAlive: true,
        rejectUnauthorized: false
    });
}

function sendSoapRequest(urlStr, soapAction, xmlPayload, agent) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const options = {
            method: 'POST',
            hostname: url.hostname,
            path: url.pathname + url.search,
            port: url.port || 443,
            agent: agent,
            timeout: 15000, // Timeout de 15 segundos
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8;',
                'SOAPAction': soapAction,
                'Content-Length': Buffer.byteLength(xmlPayload)
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => { responseData += chunk; });
            res.on('end', () => { resolve({ statusCode: res.statusCode, body: responseData }); });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("Timeout na comunicação com a SEFAZ"));
        });

        req.on('error', (err) => { reject(err); });
        req.write(xmlPayload);
        req.end();
    });
}

// Remove acentos e caracteres especiais para evitar rejeição no banco/SEFAZ
const limparTexto = (txt) => String(txt || '')
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/gi, "")
    .toUpperCase();

/**
 * Monta o lote XML de envio de guias GNRE
 */
function montarXmlLote(listaGuias, dadosEmpresa) {
    let xmlGuias = '';
    const hoje = new Date().toISOString().split('T')[0];

    // Se a empresa não fornecer dados de endereço, usamos os valores padrão da Lalua
    const emitente = {
        cnpj: dadosEmpresa.cnpj ? dadosEmpresa.cnpj.replace(/[^0-9]/g, '') : "10436619000105",
        razaoSocial: dadosEmpresa.razaoSocial || dadosEmpresa.razao_social || "LALUA COMERCIO DE MODAS EIRELI",
        endereco: dadosEmpresa.endereco || "RUA MARECHAL ANDREA 82",
        municipio: dadosEmpresa.municipio || "27408", // Salvador/BA (5 dígitos conforme XSD)
        uf: dadosEmpresa.uf || "BA",
        cep: dadosEmpresa.cep ? dadosEmpresa.cep.replace(/[^0-9]/g, '') : "41810105"
    };
    
    for (const guia of listaGuias) {
        let xmlCamposExtras = '';
        let camposExtras = [];

        // Código do campo extra para a Chave de Acesso NFe conforme a UF
        let codigoCampoChave = 55; // Padrão recomendado pela maioria das UFs
        if (guia.ufFavorecida === 'MA') {
            codigoCampoChave = 94;
        } else if (guia.ufFavorecida === 'MS') {
            codigoCampoChave = 88;
        } else if (guia.ufFavorecida === 'PR') {
            codigoCampoChave = 107;
        } else if (guia.ufFavorecida === 'SC') {
            codigoCampoChave = 84;
        }

        // PE não exige campos adicionais para a receita 100102
        if (guia.ufFavorecida !== 'PE') {
            if (guia.chaveAcessoNfe) {
                camposExtras.push({ codigo: codigoCampoChave, valor: guia.chaveAcessoNfe });
            }
        }

        // Caso especial do Rio de Janeiro com a data de emissão
        if (guia.ufFavorecida === 'RJ' && guia.dataEmissaoRJ) {
            camposExtras.push({ codigo: 117, valor: guia.dataEmissaoRJ });
        }

        if (camposExtras.length > 0) {
            xmlCamposExtras = '\n                <camposExtras>';
            for (const ce of camposExtras) {
                xmlCamposExtras += `
                  <campoExtra>
                    <codigo>${ce.codigo}</codigo>
                    <valor>${ce.valor}</valor>
                  </campoExtra>`;
            }
            xmlCamposExtras += '\n                </camposExtras>';
        }

        // Determina o tipo de documento de origem e o valor
        let tipoDoc = guia.tipoDocumentoOrigem || '10';
        let numDoc = guia.documentoOrigem;

        // Estados que exigem CHAVE DO DFe (tipo 24) no documentoOrigem
        const ufsExigemChaveDocOrigem = ['RJ', 'SC', 'PE'];
        if (ufsExigemChaveDocOrigem.includes(guia.ufFavorecida)) {
            tipoDoc = '24';
            numDoc = guia.chaveAcessoNfe;
        }

        let xmlDocOrigem = '';
        if (numDoc) {
            xmlDocOrigem = `\n                <documentoOrigem tipo="${tipoDoc}">${numDoc}</documentoOrigem>`;
        }

        // Bloco de referência de apuração (obrigatório em DF, MA, MS e recomendado nas demais)
        let xmlReferencia = '';
        if (guia.mesApuracao && guia.anoApuracao) {
            xmlReferencia = `
                <referencia>
                  <periodo>0</periodo>
                  <mes>${guia.mesApuracao}</mes>
                  <ano>${guia.anoApuracao}</ano>
                </referencia>`;
        }

        // Bloco de destinatário (obrigatório em RJ, MA, MS)
        let xmlDestinatario = '';
        if (guia.destCnpjCpf) {
            const nomeLimpo = limparTexto(guia.destNome).substring(0, 60);
            const mun5Digitos = guia.destMun ? String(guia.destMun).slice(-5) : '';
            xmlDestinatario = `
                <contribuinteDestinatario>
                  <identificacao>
                    <${guia.destTipoIdentificacao}>${guia.destCnpjCpf}</${guia.destTipoIdentificacao}>
                  </identificacao>
                  <razaoSocial>${nomeLimpo}</razaoSocial>
                  <municipio>${mun5Digitos}</municipio>
                </contribuinteDestinatario>`;
        }

        xmlGuias += `
          <TDadosGNRE versao="2.00">
            <ufFavorecida>${guia.ufFavorecida}</ufFavorecida>
            <tipoGnre>0</tipoGnre>
            <contribuinteEmitente>
              <identificacao>
                <CNPJ>${emitente.cnpj}</CNPJ>
              </identificacao>
              <razaoSocial>${emitente.razaoSocial}</razaoSocial>
              <endereco>${emitente.endereco}</endereco>
              <municipio>${emitente.municipio}</municipio>
              <uf>${emitente.uf}</uf>
              <cep>${emitente.cep}</cep>
            </contribuinteEmitente>
            <itensGNRE>
              <item>
                <receita>${guia.codigoReceita}</receita>${xmlDocOrigem}${xmlReferencia}
                <dataVencimento>${guia.dataVencimento || hoje}</dataVencimento>
                <valor tipo="11">${guia.valor}</valor>
                <valor tipo="21">${guia.valor}</valor>${xmlDestinatario}${xmlCamposExtras}
              </item>
            </itensGNRE>
            <valorGNRE>${guia.valor}</valorGNRE>
            <dataPagamento>${guia.dataPagamento || hoje}</dataPagamento>
          </TDadosGNRE>`;
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header>
    <gnreCabecMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreLoteRecepcao">
      <versaoDados>2.00</versaoDados>
    </gnreCabecMsg>
  </soap12:Header>
  <soap12:Body>
    <gnreDadosMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreLoteRecepcao">
      <TLote_GNRE xmlns="http://www.gnre.pe.gov.br" versao="2.00">
        <guias>${xmlGuias}
        </guias>
      </TLote_GNRE>
    </gnreDadosMsg>
  </soap12:Body>
</soap12:Envelope>`.trim();
}

/**
 * Envia o lote de guias para a SEFAZ
 */
async function enviarLote(listaGuias, agent, uf, environment, dadosEmpresa, logsDir) {
    const isProducao = environment === 'producao';
    const urls = isProducao ? URLS_SEFAZ.producao : URLS_SEFAZ.simulado;
    
    const soapXml = montarXmlLote(listaGuias, dadosEmpresa);
    const timestamp = Date.now();
    
    if (logsDir) {
        await fs.mkdir(logsDir, { recursive: true });
        await fs.writeFile(path.join(logsDir, `envio_lote_${timestamp}_${uf || 'geral'}.xml`), soapXml, 'utf-8');
    }

    const response = await sendSoapRequest(urls.recepcao, 'processar', soapXml, agent);
    
    if (logsDir) {
        await fs.writeFile(path.join(logsDir, `resposta_lote_${timestamp}_${uf || 'geral'}.xml`), response.body, 'utf-8');
    }

    const codigoMatch = response.body.match(/<(?:[a-zA-Z0-9]+:)?codigo>([^<]+)<\/(?:[a-zA-Z0-9]+:)?codigo>/);
    const descricaoMatch = response.body.match(/<(?:[a-zA-Z0-9]+:)?descricao>([^<]+)<\/(?:[a-zA-Z0-9]+:)?descricao>/);
    const reciboMatch = response.body.match(/<(?:[a-zA-Z0-9]+:)?numero>([^<]+)<\/(?:[a-zA-Z0-9]+:)?numero>/);
    
    if (!reciboMatch) {
        if (descricaoMatch && descricaoMatch[1]) {
            let desc = descricaoMatch[1]
                .replace(/&#xE3;/g, 'ã')
                .replace(/&#xE7;/g, 'ç')
                .replace(/&#xED;/g, 'í')
                .replace(/&#xE1;/g, 'á')
                .replace(/&#xE9;/g, 'é')
                .replace(/&#xF3;/g, 'ó')
                .replace(/&#xFA;/g, 'ú')
                .replace(/&#xE2;/g, 'â')
                .replace(/&#xEA;/g, 'ê')
                .replace(/&#xF4;/g, 'ô')
                .replace(/&#xFB;/g, 'û');
            throw new Error(`Rejeição da SEFAZ (Código ${codigoMatch ? codigoMatch[1] : 'N/A'}): ${desc}`);
        }
        throw new Error("Lote rejeitado ou estrutura inválida na resposta da SEFAZ.");
    }

    return reciboMatch[1];
}

/**
 * Consulta o processamento do lote na SEFAZ
 */
async function consultarLote(numeroRecibo, agent, uf, environment, logsDir) {
    const isProducao = environment === 'producao';
    const urls = isProducao ? URLS_SEFAZ.producao : URLS_SEFAZ.simulado;

    const soapXml = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header>
    <gnreCabecMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreResultadoLote">
      <versaoDados>2.00</versaoDados>
    </gnreCabecMsg>
  </soap12:Header>
  <soap12:Body>
    <gnreDadosMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreResultadoLote">
      <TConsLote_GNRE xmlns="http://www.gnre.pe.gov.br">
        <ambiente>${isProducao ? '1' : '2'}</ambiente>
        <numeroRecibo>${numeroRecibo}</numeroRecibo>
      </TConsLote_GNRE>
    </gnreDadosMsg>
  </soap12:Body>
</soap12:Envelope>`.trim();

    const response = await sendSoapRequest(urls.consulta, 'consultar', soapXml, agent);
    
    if (logsDir) {
        await fs.mkdir(logsDir, { recursive: true });
        await fs.writeFile(path.join(logsDir, `resultado_consulta_${numeroRecibo}.xml`), response.body, 'utf-8');
    }
    
    return response.body;
}

// Funções auxiliares para geração do código de barras
function gerarSvgI25(codigo) {
    const padroes = {
        '0': 'NNWWN', '1': 'WNNNW', '2': 'NWNNW', '3': 'WWNNN', '4': 'NNWNW',
        '5': 'WNWNN', '6': 'NWWNN', '7': 'NNNWW', '8': 'WNNWN', '9': 'NWNWN'
    };

    let bars = '1010'; // Start
    
    const codLimpo = String(codigo).replace(/[^0-9]/g, '');
    if (codLimpo.length % 2 !== 0) return '';
    
    for (let i = 0; i < codLimpo.length; i += 2) {
        const digito1 = codLimpo.charAt(i);
        const digito2 = codLimpo.charAt(i + 1);
        const p1 = padroes[digito1];
        const p2 = padroes[digito2];
        
        for (let j = 0; j < 5; j++) {
            const bWidth = p1.charAt(j) === 'W' ? '111' : '1';
            const sWidth = p2.charAt(j) === 'W' ? '000' : '0';
            bars += bWidth + sWidth;
        }
    }
    
    bars += '11101'; // Stop
    
    let svgContent = '';
    let x = 0;
    const altura = 60;
    let index = 0;
    while (index < bars.length) {
        let count = 0;
        const char = bars.charAt(index);
        while (index < bars.length && bars.charAt(index) === char) {
            count++;
            index++;
        }
        
        const largura = count * 1.25;
        if (char === '1') {
            svgContent += `<rect x="${x}" y="0" width="${largura}" height="${altura}" fill="#000000" />`;
        }
        x += largura;
    }
    
    return `<svg width="${x}" height="${altura}" viewBox="0 0 ${x} ${altura}" xmlns="http://www.w3.org/2000/svg" style="display: block; margin: 0 auto;">${svgContent}</svg>`;
}

function formatarLinhaDigitavelVisual(ld) {
    if (!ld) return '';
    const l = ld.replace(/[^0-9]/g, '');
    if (l.length === 48) {
        return `${l.slice(0, 12)} ${l.slice(12, 24)} ${l.slice(24, 36)} ${l.slice(36, 48)}`;
    }
    if (l.length === 44) {
        return `${l.slice(0, 11)} ${l.slice(11, 22)} ${l.slice(22, 33)} ${l.slice(33, 44)}`;
    }
    return ld;
}

function formatarDataVisual(dataStr) {
    if (!dataStr) return '';
    if (dataStr.includes('-')) {
        const parts = dataStr.split('T')[0].split('-');
        if (parts.length === 3) {
            const [ano, mes, dia] = parts;
            return `${dia}/${mes}/${ano}`;
        }
    }
    if (dataStr.length === 8) {
        return `${dataStr.slice(0, 2)}/${dataStr.slice(2, 4)}/${dataStr.slice(4, 8)}`;
    }
    return dataStr;
}

function formatarMoedaVisual(val) {
    return parseFloat(val || 0).toFixed(2).replace('.', ',');
}

/**
 * Renderiza a guia em formato HTML imprimível
 */
function exportarGuiaHtml(dadosEmpresa, dadosGuia, dadosNfeExtraidos) {
    const ufFavorecida = dadosNfeExtraidos ? dadosNfeExtraidos.ufFavorecida : (dadosGuia.ufFavorecida || "PE");
    const codigoReceita = dadosNfeExtraidos ? dadosNfeExtraidos.codigoReceita : "100102";
    const numeroNota = dadosNfeExtraidos ? dadosNfeExtraidos.documentoOrigem : (dadosGuia.documentoOrigem || "SEM_NUMERO");
    const chaveAcessoNfe = dadosNfeExtraidos ? dadosNfeExtraidos.chaveAcessoNfe : (dadosGuia.chaveAcessoNfe || "NÃO INFORMADA");
    
    const dataVencimentoFormatada = formatarDataVisual(dadosGuia.dataVencimento);
    const valorTotal = formatarMoedaVisual(dadosGuia.valor);
    const linhaDigitavelFormatada = formatarLinhaDigitavelVisual(dadosGuia.linhaDigitavel);
    const svgBarcode = gerarSvgI25(dadosGuia.codigoBarras);

    let valorPrincipal = formatarMoedaVisual(dadosGuia.valor);
    let instrucoesAdicionais = "";

    if (dadosNfeExtraidos && dadosNfeExtraidos.valor && parseFloat(dadosNfeExtraidos.valor) < parseFloat(dadosGuia.valor)) {
        const difal = parseFloat(dadosNfeExtraidos.valor);
        const fcp = parseFloat(dadosGuia.valor) - difal;
        valorPrincipal = formatarMoedaVisual(difal);
        instrucoesAdicionais = `<br><br><b>Detalhamento dos Valores:</b><br>DIFAL Principal: R$ ${valorPrincipal}<br>Fundo de Combate à Pobreza (FCP): R$ ${formatarMoedaVisual(fcp)}`;
    }

    // Ajusta o CNPJ da empresa para formatação visual
    const cnpjEmitente = (dadosEmpresa.cnpj || '').replace(/[^0-9]/g, '');
    const cnpjFormatado = cnpjEmitente.length === 14 
        ? cnpjEmitente.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
        : cnpjEmitente;

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>Guia GNRE - Nota Fiscal ${numeroNota}</title>
    <style>
        body { font-family: Arial, sans-serif; font-size: 11px; color: #000; margin: 20px; }
        .guia-container { width: 680px; border: 2px solid #000; padding: 10px; margin-bottom: 20px; background: #fff; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .titulo-guia { font-size: 14px; font-weight: bold; text-align: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 8px; }
        .table-guia { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
        .table-guia td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
        .label { font-size: 8px; text-transform: uppercase; font-weight: bold; color: #444; display: block; margin-bottom: 2px; }
        .valor { font-size: 11px; font-weight: bold; }
        .destaque { background-color: #f2f2f2; }
        .linha-digitavel { font-family: monospace; font-size: 13px; font-weight: bold; text-align: center; margin: 15px 0; letter-spacing: 0.5px; }
        .barcode-container { text-align: center; margin: 15px 0; }
        .autenticacao { font-size: 8px; text-align: right; border-top: 1px dashed #000; padding-top: 5px; margin-top: 15px; color: #666; }
        .via-titulo { font-size: 10px; font-weight: bold; text-align: right; margin-bottom: 5px; text-transform: uppercase; }
        @media print {
            body { margin: 0; }
            .guia-container { border: 1px solid #000; box-shadow: none; }
        }
    </style>
</head>
<body>

    <div class="guia-container">
        <div class="via-titulo">Via Contribuinte</div>
        <div class="titulo-guia">GUIA NACIONAL DE RECOLHIMENTO DE TRIBUTOS ESTADUAIS - GNRE</div>
        
        <table class="table-guia">
            <tr>
                <td colspan="3" width="60%">
                    <span class="label">Contribuinte Emitente</span>
                    <span class="valor">${dadosEmpresa.razaoSocial || dadosEmpresa.razao_social}</span><br>
                    <span class="label" style="margin-top:4px;">CNPJ</span>
                    <span>${cnpjFormatado}</span>
                </td>
                <td width="20%" class="destaque">
                    <span class="label">UF Favorecida</span>
                    <span class="valor" style="font-size: 14px;">${ufFavorecida}</span>
                </td>
                <td width="20%" class="destaque">
                    <span class="label">Código da Receita</span>
                    <span class="valor" style="font-size: 14px;">${codigoReceita}</span>
                </td>
            </tr>
            <tr>
                <td colspan="3">
                    <span class="label">Documento de Origem</span>
                    <span class="valor">Nota Fiscal Eletrônica (NF-e) nº ${numeroNota}</span>
                </td>
                <td>
                    <span class="label">Data de Vencimento</span>
                    <span class="valor">${dataVencimentoFormatada}</span>
                </td>
                <td>
                    <span class="label">Data Limite de Pagto</span>
                    <span class="valor">${dataVencimentoFormatada}</span>
                </td>
            </tr>
            <tr>
                <td colspan="3" rowspan="3">
                    <span class="label">Chave de Acesso da NF-e</span>
                    <span class="valor" style="font-family: monospace; font-size: 10px;">${chaveAcessoNfe}</span>
                    <br><br>
                    <span class="label">Instruções</span>
                    <span style="font-size: 9px; color: #555;">Guia emitida via integração Webservice GNRE v2.00.<br>Destinada ao recolhimento de DIFAL - Consumidor Final não contribuinte.${instrucoesAdicionais}</span>
                </td>
                <td class="destaque">
                    <span class="label">Valor Principal</span>
                    <span class="valor">R$ ${valorPrincipal}</span>
                </td>
                <td class="destaque">
                    <span class="label">Atualização Monetária</span>
                    <span class="valor">R$ 0,00</span>
                </td>
            </tr>
            <tr>
                <td class="destaque">
                    <span class="label">Juros / Encargos</span>
                    <span class="valor">R$ 0,00</span>
                </td>
                <td class="destaque">
                    <span class="label">Multa de Mora</span>
                    <span class="valor">R$ 0,00</span>
                </td>
            </tr>
            <tr>
                <td class="destaque" style="border-top: 2px solid #000;">
                    <span class="label">Valor Total</span>
                    <span class="valor" style="font-size: 12px;">R$ ${valorTotal}</span>
                </td>
                <td class="destaque" style="border-top: 2px solid #000;">
                    <span class="label">Código de Autenticação</span>
                    <span class="valor">-</span>
                </td>
            </tr>
        </table>

        <div class="linha-digitavel">${linhaDigitavelFormatada}</div>
        
        <div class="barcode-container">
            ${svgBarcode}
        </div>
        
        <div class="autenticacao">Autenticação Mecânica no Verso / Controle Fiscal SEFAZ-${ufFavorecida}</div>
    </div>

</body>
</html>`.trim();
}

module.exports = {
    createHttpsAgent,
    enviarLote,
    consultarLote,
    exportarGuiaHtml,
    gerarSvgI25,
    formatarLinhaDigitavelVisual,
    formatarDataVisual,
    formatarMoedaVisual
};
