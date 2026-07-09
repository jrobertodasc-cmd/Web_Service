// services/dua_es_service.js
// Comunicação SOAP 1.2 com a SEFAZ-ES e emissão de DUA-e (Documento Único de Arrecadação)

const https = require('https');
const parserService = require('./parser_service');

const URLS_SEFAZ_ES = {
    producao: "https://app.sefaz.es.gov.br/WsDua/DuaService.asmx",
    homologacao: "https://homologacao.sefaz.es.gov.br/WsDua/DuaService.asmx"
};

// Tabela de mapeamento de código IBGE (6 ou 7 dígitos) para código de município do DUA-ES
const MUNICIPIOS_ES_MAP = {
  "3200102": "56014", "320010": "56014",
  "3200169": "57177", "320016": "57177",
  "3200136": "57339", "320013": "57339",
  "3200201": "56030", "320020": "56030",
  "3200300": "56057", "320030": "56057",
  "3200359": "57193", "320035": "57193",
  "3200409": "56073", "320040": "56073",
  "3200508": "56090", "320050": "56090",
  "3200607": "56111", "320060": "56111",
  "3200706": "56138", "320070": "56138",
  "3200805": "56154", "320080": "56154",
  "3200904": "56170", "320090": "56170",
  "3201001": "56197", "320100": "56197",
  "3201100": "56219", "320110": "56219",
  "3201159": "07587", "320115": "07587",
  "3201209": "56235", "320120": "56235",
  "3201308": "56251", "320130": "56251",
  "3201407": "56278", "320140": "56278",
  "3201506": "56294", "320150": "56294",
  "3201605": "56316", "320160": "56316",
  "3201704": "56332", "320170": "56332",
  "3201803": "56359", "320180": "56359",
  "3201902": "56375", "320190": "56375",
  "3202009": "56391", "320200": "56391",
  "3202108": "56413", "320210": "56413",
  "3202207": "56430", "320220": "56430",
  "3202256": "11142", "320225": "11142",
  "3202306": "56456", "320230": "56456",
  "3202405": "56472", "320240": "56472",
  "3202454": "57096", "320245": "57096",
  "3202504": "56499", "320250": "56499",
  "3202553": "60119", "320255": "60119",
  "3202603": "56510", "320260": "56510",
  "3202652": "29319", "320265": "29319",
  "3202702": "56537", "320270": "56537",
  "3202801": "56553", "320280": "56553",
  "3202900": "56570", "320290": "56570",
  "3203007": "56596", "320300": "56596",
  "3203056": "57134", "320305": "57134",
  "3203106": "56618", "320310": "56618",
  "3203130": "57215", "320313": "57215",
  "3203163": "57231", "320316": "57231",
  "3203205": "56634", "320320": "56634",
  "3203304": "56650", "320330": "56650",
  "3203320": "07609", "320332": "07609",
  "3203346": "29297", "320334": "29297",
  "3203353": "57070", "320335": "57070",
  "3203403": "56677", "320340": "56677",
  "3203502": "56693", "320350": "56693",
  "3203601": "56715", "320360": "56715",
  "3203700": "56731", "320370": "56731",
  "3203809": "56758", "320380": "56758",
  "3203908": "56774", "320390": "56774",
  "3204005": "56790", "320400": "56790",
  "3204054": "57150", "320405": "57150",
  "3204104": "56812", "320410": "56812",
  "3204203": "56839", "320420": "56839",
  "3204252": "07625", "320425": "07625",
  "3204302": "56855", "320430": "56855",
  "3204351": "57118", "320435": "57118",
  "3204401": "56871", "320440": "56871",
  "3204500": "56898", "320450": "56898",
  "3204559": "57258", "320455": "57258",
  "3204609": "56910", "320460": "56910",
  "3204658": "29335", "320465": "29335",
  "3204708": "56936", "320470": "56936",
  "3204807": "56952", "320480": "56952",
  "3204906": "56979", "320490": "56979",
  "3204955": "07641", "320495": "07641",
  "3205002": "56995", "320500": "56995",
  "3205010": "07668", "320501": "07668",
  "3205036": "57274", "320503": "57274",
  "3205069": "57290", "320506": "57290",
  "3205101": "57010", "320510": "57010",
  "3205150": "29351", "320515": "29351",
  "3205176": "07684", "320517": "07684",
  "3205200": "57037", "320520": "57037",
  "3205309": "57053", "320530": "57053"
};

function sendSoapRequest(urlStr, soapAction, xmlPayload, agent) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const options = {
            method: 'POST',
            hostname: url.hostname,
            path: url.pathname + url.search,
            port: url.port || 443,
            agent: agent,
            timeout: 45000, // Timeout de 45 segundos (ajustado para servidores governamentais lentos)
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8; action="' + soapAction + '"',
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
            reject(new Error("Timeout na comunicação com a SEFAZ-ES"));
        });

        req.on('error', (err) => { reject(err); });
        req.write(xmlPayload);
        req.end();
    });
}

/**
 * Constrói a mensagem SOAP para emissão de DUA
 */
function construirXmlEmissao(dadosDua, environment) {
    const isProducao = environment === 'producao';
    const tpAmb = isProducao ? '1' : '2';

    const cnpjEmi = String(dadosDua.cnpjEmitente || '').replace(/[^0-9]/g, '');
    const cnpjOrg = "27080571000130"; // SEFAZ-ES
    const cArea = "1902"; // Receita de ICMS
    const cServ = "3867"; // ICMS - Diferencial de Alíquota
    const cnpjPes = String(dadosDua.destCnpjCpf || '').replace(/[^0-9]/g, '');
    
    const dRef = dadosDua.anoApuracao && dadosDua.mesApuracao 
        ? `${dadosDua.anoApuracao}-${dadosDua.mesApuracao}` 
        : new Date().toISOString().slice(0, 7); // AAAA-MM
        
    const dVen = dadosDua.dataVencimento || new Date().toISOString().split('T')[0];
    const dPag = dadosDua.dataPagamento || new Date().toISOString().split('T')[0];
    
    // Procura o código IBGE correspondente na tabela DUA-ES. Se não achar, usa Vitória como default
    const ibgeLimpo = String(dadosDua.destMun || '').trim();
    const cMun = MUNICIPIOS_ES_MAP[ibgeLimpo] || "57053";

    const xInf = String(`NF-e N. ${dadosDua.documentoOrigem || 'SEM NUMERO'} | Chave: ${dadosDua.chaveAcessoNfe || ''}`).substring(0, 256).replace(/[<>]/g, '');
    const vRec = parseFloat(dadosDua.valor || 0).toFixed(2);
    const xIde = String(`NF ${dadosDua.documentoOrigem || ''}`).substring(0, 30);

    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:duae="http://www.sefaz.es.gov.br/duae">
   <soap:Header>
      <duae:DuaServiceHeader>
         <duae:versao>1.01</duae:versao>
      </duae:DuaServiceHeader>
   </soap:Header>
   <soap:Body>
      <duae:duaEmissao>
         <duae:duaDadosMsg>
          <emisDua versao="1.01" xmlns="http://www.sefaz.es.gov.br/duae">
            <tpAmb>${tpAmb}</tpAmb>
            <cnpjEmi>${cnpjEmi}</cnpjEmi>
            <cnpjOrg>${cnpjOrg}</cnpjOrg>
            <cArea>${cArea}</cArea>
            <cServ>${cServ}</cServ>
            <cnpjPes>${cnpjPes}</cnpjPes>
            <dRef>${dRef}</dRef>
            <dVen>${dVen}</dVen>
            <dPag>${dPag}</dPag>
            <cMun>${cMun}</cMun>
            <xInf>${xInf}</xInf>
            <vRec>${vRec}</vRec>
            <xIde>${xIde}</xIde>
            <fPix>true</fPix>
          </emisDua>
         </duae:duaDadosMsg>
      </duae:duaEmissao>
   </soap:Body>
</soap:Envelope>`.trim();
}

/**
 * Constrói a mensagem SOAP para obter o PDF da DUA
 */
function construirXmlObterPdf(nDua, cnpj, environment) {
    const isProducao = environment === 'producao';
    const tpAmb = isProducao ? '1' : '2';
    const cnpjLimpo = String(cnpj || '').replace(/[^0-9]/g, '');

    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:duae="http://www.sefaz.es.gov.br/duae">
    <soap:Header>
        <duae:DuaServiceHeader>
            <duae:versao>1.01</duae:versao>
        </duae:DuaServiceHeader>
    </soap:Header>
    <soap:Body>
        <duae:duaObterPdf>
            <duae:duaDadosMsg>
                <obterPdfDua versao="1.01" xmlns="http://www.sefaz.es.gov.br/duae">
                    <tpAmb>${tpAmb}</tpAmb>
                    <nDua>${nDua}</nDua>
                    <cnpj>${cnpjLimpo}</cnpj>
                </obterPdfDua>
            </duae:duaDadosMsg>
        </duae:duaObterPdf>
    </soap:Body>
</soap:Envelope>`.trim();
}

/**
 * Transmite o pedido de emissão para a SEFAZ-ES
 */
async function transmitirEmissao(dadosDua, agent, environment) {
    const isProducao = environment === 'producao';
    const endpoint = isProducao ? URLS_SEFAZ_ES.producao : URLS_SEFAZ_ES.homologacao;
    const soapAction = "http://www.sefaz.es.gov.br/duae/duaEmissao";

    let payload = construirXmlEmissao(dadosDua, environment);
    let response = await sendSoapRequest(endpoint, soapAction, payload, agent);

    if (response.statusCode !== 200) {
        throw new Error(`Erro na conexão HTTP com a SEFAZ-ES (Status ${response.statusCode})`);
    }

    let cStat = parserService.extrairTag(response.body, 'cStat');
    let xMotivo = parserService.extrairTag(response.body, 'xMotivo') || 'Motivo desconhecido';

    // Se a apuração estiver fechada (cStat 801), retenta com a referência do mês de pagamento
    if (cStat === '801') {
        const dPag = dadosDua.dataPagamento || new Date().toISOString().split('T')[0];
        const novaRef = dPag.slice(0, 7); // AAAA-MM
        const antigaRef = dadosDua.anoApuracao && dadosDua.mesApuracao ? `${dadosDua.anoApuracao}-${dadosDua.mesApuracao}` : '';
        
        if (novaRef && novaRef !== antigaRef) {
            console.log(`[ES] ⚠ Período ${antigaRef} fechado (cStat 801). Retentando com referência do pagamento: ${novaRef}`);
            const dadosAlt = { ...dadosDua, anoApuracao: novaRef.split('-')[0], mesApuracao: novaRef.split('-')[1] };
            payload = construirXmlEmissao(dadosAlt, environment);
            response = await sendSoapRequest(endpoint, soapAction, payload, agent);
            
            if (response.statusCode !== 200) {
                throw new Error(`Erro na conexão HTTP com a SEFAZ-ES na retentativa (Status ${response.statusCode})`);
            }
            cStat = parserService.extrairTag(response.body, 'cStat');
            xMotivo = parserService.extrairTag(response.body, 'xMotivo') || 'Motivo desconhecido';
        }
    }

    if (cStat !== '105') {
        throw new Error(`Rejeição da SEFAZ-ES (Código ${cStat || 'N/A'}): ${xMotivo}`);
    }

    const nDua = parserService.extrairTag(response.body, 'nDua');
    const nBar = parserService.extrairTag(response.body, 'nBar');

    if (!nDua || !nBar) {
        throw new Error("Resposta da SEFAZ-ES não retornou o número da DUA ou o código de barras.");
    }

    return { nDua, nBar };
}

/**
 * Transmite o pedido de obtenção do PDF para a SEFAZ-ES e retorna o buffer binário do PDF
 */
async function transmitirObterPdf(nDua, cnpj, agent, environment) {
    const isProducao = environment === 'producao';
    const endpoint = isProducao ? URLS_SEFAZ_ES.producao : URLS_SEFAZ_ES.homologacao;
    const soapAction = "http://www.sefaz.es.gov.br/duae/duaObterPdf";

    const payload = construirXmlObterPdf(nDua, cnpj, environment);
    const response = await sendSoapRequest(endpoint, soapAction, payload, agent);

    if (response.statusCode !== 200) {
        throw new Error(`Erro na conexão HTTP com a SEFAZ-ES para PDF (Status ${response.statusCode})`);
    }

    const cStat = parserService.extrairTag(response.body, 'cStat');
    const xMotivo = parserService.extrairTag(response.body, 'xMotivo') || 'Motivo desconhecido';

    if (cStat !== '106') {
        throw new Error(`Erro ao obter PDF da SEFAZ-ES (Código ${cStat || 'N/A'}): ${xMotivo}`);
    }

    const xPdfBase64 = parserService.extrairTag(response.body, 'xPdf');
    if (!xPdfBase64) {
        throw new Error("Arquivo PDF em base64 não retornado pela SEFAZ-ES.");
    }

    return Buffer.from(xPdfBase64.trim(), 'base64');
}

module.exports = {
    transmitirEmissao,
    transmitirObterPdf
};
