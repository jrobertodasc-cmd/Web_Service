/**
 * gnre_integration.js - Versão Master (Fiscal + Bancária)
 * Integração GNRE v2.00 e Geração de Remessa Itaú SISPAG (CNAB 240 v086).
 */

const https = require('https');
const fs = require('fs/promises');
const path = require('path');

// Função utilitária para pausar a execução
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================
// CONSTANTES DE CONFIGURAÇÃO
// ==========================================

let MODO_PRODUCAO = process.argv.includes('--producao');

let URL_RECEPCAO = MODO_PRODUCAO
    ? "https://www.gnre.pe.gov.br/gnreWS/services/GnreLoteRecepcao"
    : "https://www.testegnre.pe.gov.br/gnreWS/services/GnreLoteRecepcao";

let URL_CONSULTA = MODO_PRODUCAO
    ? "https://www.gnre.pe.gov.br/gnreWS/services/GnreResultadoLote"
    : "https://www.testegnre.pe.gov.br/gnreWS/services/GnreResultadoLote";

const PASTA_CERTIFICADOS = path.join(__dirname, 'CERTIFICADOS');
const PASTA_LOGS = path.join(__dirname, 'xml_logs');
const PASTA_INPUT_XML = path.join(__dirname, 'xml_nfe');
const PASTA_GUIAS_EMITIDAS = path.join(__dirname, 'guias_emitidas');
const PASTA_XML_GERADOS = path.join(__dirname, 'xml_gerados');

// Senha do certificado digital PFX
const PFX_PASSPHRASE = "dmf1977";

// Dados da sua conta para o Header do Arquivo Bancário Itaú
const DADOS_BANCARIOS_EMPRESA = {
    cnpj: "10436619000105",
    razaoSocial: "LALUA COMERCIO DE MODAS EIRELI",
    agencia: "0334",
    conta: "98775",
    dac: "7"
};

const TAREFAS_ATIVAS = {};

class TaskLogger {
    constructor() {
        this.logs = [];
    }
    log(msg) {
        this.logs.push({ msg, tipo: 'info' });
        console.log(msg);
    }
    warn(msg) {
        this.logs.push({ msg, tipo: 'warning' });
        console.warn(msg);
    }
    error(msg) {
        this.logs.push({ msg, tipo: 'error' });
        console.error(msg);
    }
}

// ==========================================
// FUNÇÕES AUXILIARES POSICIONAIS (CNAB 240)
// ==========================================
const padZero = (num, size) => String(num || 0).padStart(size, '0').slice(0, size);
const padSpace = (str, size) => String(str || '').padEnd(size, ' ').slice(0, size);

// Remove acentos e caracteres especiais para evitar rejeição no banco
const limparTexto = (txt) => String(txt)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/gi, "")
    .toUpperCase();

// Formatadores de data para o padrão DDMMAAAA exigido pelo banco
const formatarDataCNAB = (dataStr) => {
    // Trata formato YYYY-MM-DD vindo do XML fiscal
    if (dataStr.includes('-')) {
        const [ano, mes, dia] = dataStr.split('-');
        return `${dia}${mes}${ano}`;
    }
    return dataStr.replace(/[^0-9]/g, '');
};

// ==========================================
// INFRAESTRUTURA DE DIRETÓRIOS E LOGS
// ==========================================
async function garantirPastas() {
    await fs.mkdir(PASTA_LOGS, { recursive: true });
    await fs.mkdir(PASTA_INPUT_XML, { recursive: true });
    await fs.mkdir(PASTA_CERTIFICADOS, { recursive: true });
    await fs.mkdir(PASTA_GUIAS_EMITIDAS, { recursive: true });
    await fs.mkdir(PASTA_XML_GERADOS, { recursive: true });
}

async function salvarLogXML(nomeArquivo, conteudoXml, logger) {
    await garantirPastas();
    await fs.writeFile(path.join(PASTA_LOGS, nomeArquivo), conteudoXml, 'utf-8');
    const msg = ` 💾 Log salvo: xml_logs/${nomeArquivo}`;
    if (logger) {
        logger.log(msg);
    } else {
        console.log(msg);
    }
}

// ==========================================
// PARSER XML (EXTRAÇÃO DO CÓDIGO DE BARRAS)
// ==========================================

// Função auxiliar genérica para extrair dados de tags ignorando namespaces (Ex: <ns1:tag> vira tag)
function extrairTag(xml, tagName) {
    const regex = new RegExp('<(?:[a-zA-Z0-9]+:)?' + tagName + '[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?' + tagName + '>');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
}

async function extrairDadosGuiaXML(caminhoXml) {
    try {
        const xml = await fs.readFile(caminhoXml, 'utf-8');

        // 1. Tratamento de Rejeições (SEFAZ-PE ou Portal GNRE)
        // Caso haja rejeição do lote antes do processamento individual das guias
        const motivoRejeicao = extrairTag(xml, 'motivoRejeicao') || extrairTag(xml, 'motivosRejeicao');
        const codigoRejeicao = extrairTag(xml, 'codigo') || extrairTag(xml, 'codigoRejeicao');
        
        if (motivoRejeicao || (codigoRejeicao && codigoRejeicao === '102')) {
            const descRejeicao = extrairTag(xml, 'descricao') || "Rejeição geral do lote";
            throw new Error(`O Lote foi rejeitado pelo governo: ${descRejeicao}`);
        }

        const guias = [];
        const regexGuia = /<(?:[a-zA-Z0-9]+:)?guia[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?guia>/g;
        let matchGuia;

        // Tenta buscar por blocos <guia>...</guia> (Múltiplas guias em lote)
        while ((matchGuia = regexGuia.exec(xml)) !== null) {
            const xmlGuia = matchGuia[1];

            // Verifica rejeição individual da guia
            const situacaoGuia = extrairTag(xmlGuia, 'situacaoGuia');
            if (situacaoGuia && situacaoGuia !== '0') {
                const motivos = [];
                const regexMotivo = /<(?:[a-zA-Z0-9]+:)?descricao>([^<]+)<\/(?:[a-zA-Z0-9]+:)?descricao>/g;
                let matchMotivo;
                while ((matchMotivo = regexMotivo.exec(xmlGuia)) !== null) {
                    motivos.push(matchMotivo[1]);
                }
                const erroMsg = motivos.length > 0 ? motivos.join(' | ') : "Guia invalidada pela SEFAZ";
                console.warn(`⚠ Guia individual ignorada devido a falhas: ${erroMsg}`);
                continue; // Pula essa guia e segue para a próxima
            }

            const codigoBarras = extrairTag(xmlGuia, 'codigoBarras');
            const linhaDigitavel = extrairTag(xmlGuia, 'linhaDigitavel');
            
            const valorStr = extrairTag(xmlGuia, 'valorGNRE') || 
                             extrairTag(xmlGuia, 'c10_valorTotal') || 
                             extrairTag(xmlGuia, 'valor');
            
            const vencimentoStr = extrairTag(xmlGuia, 'dataVencimento') || 
                                  extrairTag(xmlGuia, 'c14_dataVencimento');

            const docOrigemStr = extrairTag(xmlGuia, 'documentoOrigem') ||
                                 extrairTag(xmlGuia, 'c05_referencia');

            if (!codigoBarras && !linhaDigitavel) {
                continue;
            }

            const codBarrasLimpo = codigoBarras ? codigoBarras.replace(/[^0-9]/g, '') : (linhaDigitavel ? linhaDigitavel.replace(/[^0-9]/g, '') : '');
            const linDigitavelLimpa = linhaDigitavel ? linhaDigitavel.replace(/[^0-9]/g, '') : codBarrasLimpo;
            const docOrigemLimpo = docOrigemStr ? docOrigemStr.replace(/[^A-Za-z0-9]/g, '') : "SEM_NUMERO";

            const ufFavorecida = extrairTag(xmlGuia, 'ufFavorecida');
            const chaveMatch = xmlGuia.match(/\d{44}/);
            const chaveAcessoNfe = chaveMatch ? chaveMatch[0] : null;

            guias.push({
                codigoBarras: codBarrasLimpo,
                linhaDigitavel: linDigitavelLimpa,
                valor: parseFloat(valorStr ? valorStr : 0),
                dataVencimento: vencimentoStr ? vencimentoStr : "2026-07-15",
                documentoOrigem: docOrigemLimpo,
                ufFavorecida: ufFavorecida || null,
                chaveAcessoNfe: chaveAcessoNfe || null
            });
        }

        // Se não encontrou nenhuma guia estruturada por blocos <guia>, tenta buscar no XML completo como guia única
        if (guias.length === 0) {
            const codigoBarras = extrairTag(xml, 'codigoBarras');
            const linhaDigitavel = extrairTag(xml, 'linhaDigitavel');
            
            const valorStr = extrairTag(xml, 'valorGNRE') || 
                             extrairTag(xml, 'c10_valorTotal') || 
                             extrairTag(xml, 'valor');
            
            const vencimentoStr = extrairTag(xml, 'dataVencimento') || 
                                  extrairTag(xml, 'c14_dataVencimento');

            const docOrigemStr = extrairTag(xml, 'documentoOrigem');

            if (codigoBarras || linhaDigitavel) {
                const codBarrasLimpo = codigoBarras ? codigoBarras.replace(/[^0-9]/g, '') : (linhaDigitavel ? linhaDigitavel.replace(/[^0-9]/g, '') : '');
                const linDigitavelLimpa = linhaDigitavel ? linhaDigitavel.replace(/[^0-9]/g, '') : codBarrasLimpo;
                const docOrigemLimpo = docOrigemStr ? docOrigemStr.replace(/[^A-Za-z0-9]/g, '') : "SEM_NUMERO";
                
                const ufFavorecida = extrairTag(xml, 'ufFavorecida');
                const chaveMatch = xml.match(/\d{44}/);
                const chaveAcessoNfe = chaveMatch ? chaveMatch[0] : null;

                guias.push({
                    codigoBarras: codBarrasLimpo,
                    linhaDigitavel: linDigitavelLimpa,
                    valor: parseFloat(valorStr ? valorStr : 0),
                    dataVencimento: vencimentoStr ? vencimentoStr : "2026-07-15",
                    documentoOrigem: docOrigemLimpo,
                    ufFavorecida: ufFavorecida || null,
                    chaveAcessoNfe: chaveAcessoNfe || null
                });
            }
        }

        if (guias.length === 0) {
            throw new Error("Nenhuma guia processada com sucesso foi localizada no XML de resposta.");
        }

        return guias;
    } catch (err) {
        throw new Error(`Falha no processador do XML Fiscal: ${err.message}`);
    }
}

/**
 * Lê o XML de uma NF-e de venda (padrão nacional) e extrai
 * os dados essenciais para montagem automática da guia GNRE de DIFAL.
 */
async function extrairDadosNfeXML(caminhoXml) {
    try {
        const xml = await fs.readFile(caminhoXml, 'utf-8');

        // Extrai a Chave de Acesso (atributo Id na tag infNFe)
        const chaveMatch = xml.match(/<infNFe\s+[^>]*Id="NFe([^"]+)"/);
        // Extrai o Número da Nota (tag nNF)
        const numeroMatch = xml.match(/<nNF>([^<]+)<\/nNF>/);
        // Extrai o CNPJ do Emitente (dentro do grupo emit)
        const emitenteMatch = xml.match(/<emit>[^]*?<CNPJ>([^<]+)<\/CNPJ>/);
        // Extrai a UF do Destinatário (dentro de dest -> enderDest -> UF)
        const ufDestMatch = xml.match(/<dest>[^]*?<UF>([^<]+)<\/UF>/);
        
        // Extrai o Valor do DIFAL Destino (tag vICMSUFDest no ICMSTot - Bloco de totais da NF-e)
        const totalMatch = xml.match(/<ICMSTot>([\s\S]*?)<\/ICMSTot>/);
        let valorDifalMatch = null;
        if (totalMatch) {
            valorDifalMatch = totalMatch[1].match(/<vICMSUFDest>([^<]+)<\/vICMSUFDest>/);
        }

        if (!chaveMatch || !numeroMatch || !emitenteMatch || !ufDestMatch || !valorDifalMatch) {
            throw new Error("Não foi possível extrair todos os dados fiscais essenciais do XML da NF-e.");
        }

        // Extrai dados do destinatario
        const destCnpjMatch = xml.match(/<dest>[^]*?<CNPJ>([^<]+)<\/CNPJ>/);
        const destCpfMatch = xml.match(/<dest>[^]*?<CPF>([^<]+)<\/CPF>/);
        const destCnpjCpf = destCnpjMatch ? destCnpjMatch[1] : (destCpfMatch ? destCpfMatch[1] : null);
        const destTipoIdentificacao = destCnpjMatch ? "CNPJ" : (destCpfMatch ? "CPF" : null);

        const destNomeMatch = xml.match(/<dest>[^]*?<xNome>([^<]+)<\/xNome>/);
        const destNome = destNomeMatch ? destNomeMatch[1] : null;

        const destMunMatch = xml.match(/<dest>[^]*?<cMun>([^<]+)<\/cMun>/);
        const destMun = destMunMatch ? destMunMatch[1] : null;

        // Extrai data de emissao
        const dataEmiMatch = xml.match(/<dhEmi>([^<]+)<\/dhEmi>/);
        const dhEmi = dataEmiMatch ? dataEmiMatch[1] : new Date().toISOString();
        
        // Ex: 2026-04-23T06:32:00-03:00
        const anoApur = dhEmi.substring(0, 4);
        const mesApur = dhEmi.substring(5, 7);
        const diaEmi = dhEmi.substring(8, 10);
        
        // RJ exige data no formato AAAA-MM-DD (padrão internacional) no campo extra 117
        const dataEmissaoFormatadaRJ = dhEmi.substring(0, 10);

        // Vencimento padrao: hoje
        const hoje = new Date().toISOString().split('T')[0];

        return {
            ufFavorecida: ufDestMatch[1],
            cnpjEmitente: emitenteMatch[1],
            codigoReceita: "100102", // DIFAL Consumidor Final
            valor: parseFloat(valorDifalMatch[1]).toFixed(2),
            dataVencimento: hoje, // Sera sobrescrito se especificado via parametro/interface
            tipoDocumentoOrigem: "10", // NF-e
            documentoOrigem: numeroMatch[1],
            chaveAcessoNfe: chaveMatch[1],
            
            // Novos campos para a v2.00 e regras de UFs
            destCnpjCpf,
            destTipoIdentificacao,
            destNome,
            destMun,
            anoApuracao: anoApur,
            mesApuracao: mesApur,
            dataEmissaoRJ: dataEmissaoFormatadaRJ
        };
    } catch (err) {
        throw new Error(`Falha ao ler XML da NF-e: ${err.message}`);
    }
}

// ==========================================
// GERADOR REMESSA ITAÚ SISPAG (CNAB 240)
// ==========================================
async function gerarRemessaSispag(dadosEmpresa, guiasExtraidas, logger) {
    const log = logger ? (msg) => logger.log(msg) : console.log;
    log("\n=== [BANCÁRIO] Iniciando Geração do Arquivo CNAB 240 (Itaú SISPAG) ===");
    
    const linhas = [];
    const dataHoje = new Date().toLocaleDateString('pt-BR').replace(/[^0-9]/g, ''); // DDMMAAAA
    const horaHoje = new Date().toLocaleTimeString('pt-BR').replace(/[^0-9]/g, ''); // HHMMSS
    
    // 1. REGISTRO 0: HEADER DE ARQUIVO (Layout 080)
    let headerArquivo = '';
    headerArquivo += padZero(341, 3);                              // 001-003: Banco Itaú
    headerArquivo += padZero(0, 4);                                // 004-007: Lote de Serviço
    headerArquivo += '0';                                          // 008-008: Tipo Registro (0=Header Arquivo)
    headerArquivo += padSpace('', 6);                              // 009-014: Brancos
    headerArquivo += padZero(86, 3);                               // 015-017: Versão do Layout do Arquivo (086)
    headerArquivo += '2';                                          // 018-018: Tipo Inscrição (2=CNPJ)
    headerArquivo += padZero(dadosEmpresa.cnpj, 14);               // 019-032: Número CNPJ
    headerArquivo += padSpace('', 20);                             // 033-052: Código do Convênio no Banco (Brancos)
    headerArquivo += padZero(dadosEmpresa.agencia, 5);             // 053-057: Agência Débito
    headerArquivo += padSpace('', 1);                              // 058-058: Branco
    headerArquivo += padZero(dadosEmpresa.conta, 12);              // 059-070: Conta Corrente
    headerArquivo += padSpace('', 1);                              // 071-071: Branco
    headerArquivo += padZero(dadosEmpresa.dac, 1);                 // 072-072: Dígito Verificador DAC
    headerArquivo += padSpace(limparTexto(dadosEmpresa.razaoSocial), 30); // 073-102: Nome da Empresa
    headerArquivo += padSpace("BANCO ITAU SA", 30);                // 103-132: Nome do Banco
    headerArquivo += padSpace('', 10);                             // 133-142: Uso FEBRABAN (Brancos)
    headerArquivo += '1';                                          // 143-143: Código Remessa (1)
    headerArquivo += padZero(dataHoje, 8);                         // 144-151: Data de Geração
    headerArquivo += padZero(horaHoje, 6);                         // 152-157: Hora de Geração
    headerArquivo += padZero(0, 9);                                // 158-166: Zeros (Complemento de Registro)
    headerArquivo += padZero(0, 5);                                // 167-171: Densidade Grav. (00000)
    headerArquivo += padSpace('', 20);                             // 172-191: Uso Banco (Brancos)
    headerArquivo += padSpace('', 20);                             // 192-211: Uso Empresa (Brancos)
    headerArquivo += padSpace('', 29);                             // 212-240: Uso FEBRABAN (Brancos)
    linhas.push(headerArquivo);

    // 2. REGISTRO 1: HEADER DE LOTE (Layout 030 - Tributos)
    let headerLote = '';
    headerLote += padZero(341, 3);                                 // 001-003: Banco
    headerLote += padZero(1, 4);                                   // 004-007: Lote Sequencial
    headerLote += '1';                                             // 008-008: Tipo Registro (1=Header Lote)
    headerLote += 'C';                                             // 009-009: Operação (C=Crédito)
    headerLote += padZero(22, 2);                                  // 010-011: Tipo de Serviço (22=Tributos)
    headerLote += padZero(91, 2);                                  // 012-013: Forma Lançamento (91=GNRE com Cód. Barras)
    headerLote += padZero(40, 3);                                  // 014-016: Layout do Lote (040)
    headerLote += padSpace('', 1);                                 // 017-017: Branco
    headerLote += '2';                                             // 018-018: Tipo Inscrição
    headerLote += padZero(dadosEmpresa.cnpj, 14);                  // 019-032: CNPJ Empresa
    headerLote += padSpace('', 4);                                 // 033-036: Identificação Lançamento
    headerLote += padSpace('', 16);                                // 037-052: Brancos
    headerLote += padZero(dadosEmpresa.agencia, 5);                // 053-057: Agência
    headerLote += padSpace('', 1);                                 // 058-058: Branco
    headerLote += padZero(dadosEmpresa.conta, 12);                 // 059-070: Conta
    headerLote += padSpace('', 1);                                 // 071-071: Branco
    headerLote += padZero(dadosEmpresa.dac, 1);                    // 072-072: DAC
    headerLote += padSpace(limparTexto(dadosEmpresa.razaoSocial), 30); // 073-102: Empresa
    headerLote += padSpace('', 30);                                // 103-132: Finalidade Lote
    headerLote += padSpace('', 10);                                // 133-142: Histórico C/C
    headerLote += padSpace('', 30);                                // 143-172: Logradouro/Endereço
    headerLote += padZero(0, 5);                                   // 173-177: Número do Local (Preenchido com zeros)
    headerLote += padSpace('', 35);                                // 178-212: Bairro e Cidade
    headerLote += padZero(0, 8);                                   // 213-220: CEP (Preenchido com zeros)
    headerLote += padSpace('', 20);                                // 221-240: UF + Uso FEBRABAN
    linhas.push(headerLote);

    let totalLoteFinanceiro = 0;
    // O lote começa no Header de Lote (1).
    let contadorRegistrosLote = 1; 

    // 3. REGISTRO 3: DETALHE - SEGMENTO O (Tributos com Código de Barras)
    guiasExtraidas.forEach((guia, idx) => {
        let segO = '';
        const seq = idx + 1;
        contadorRegistrosLote++; // Incrementa para o segmento O
        totalLoteFinanceiro += guia.valor;

        segO += padZero(341, 3);                                   // 001-003: Banco
        segO += padZero(1, 4);                                     // 004-007: Lote
        segO += '3';                                               // 008-008: Tipo Registro (3=Detalhe)
        segO += padZero(seq, 5);                                   // 009-013: Sequencial no Lote
        segO += 'O';                                               // 014-014: Segmento (O)
        segO += padZero(0, 3);                                     // 015-017: Tipo Movimento (000=Inclusão)
        segO += padSpace(guia.codigoBarras, 48);                   // 018-065: Código de Barras da Guia
        segO += padSpace("SEFAZ PE GNRE TRIBUTOS", 30);            // 066-095: Nome Concessionária/Órgão
        segO += padZero(formatarDataCNAB(guia.dataVencimento), 8); // 096-103: Vencimento
        segO += 'REA';                                             // 104-106: Moeda (REA)
        segO += padZero(0, 15);                                    // 107-121: Qtd Moeda
        
        // Valor sem pontos em centavos (Ex: 150.00 vira 15000)
        const valorEmCentavos = Math.round(guia.valor * 100);
        segO += padZero(valorEmCentavos, 15);                      // 122-136: Valor da Guia
        segO += padZero(dataHoje, 8);                              // 137-144: Data de Pagamento (Agendado para hoje)
        segO += padZero(0, 15);                                    // 145-159: Valor Pago (Preenche com zeros na remessa)
        segO += padSpace('', 3);                                   // 160-162: Brancos
        segO += padSpace('', 9);                                   // 163-171: Complemento de Registro (Devem ser Brancos)
        segO += padSpace('', 3);                                   // 172-174: Brancos
        segO += padSpace(`GNRE-NF-${idx + 1}`, 20);                // 175-194: Seu Número (ID do documento no seu sistema)
        segO += padSpace('', 21);                                  // 195-215: Brancos
        segO += padSpace('', 15);                                  // 216-230: Nosso Número
        segO += padSpace('', 10);                                  // 231-240: Ocorrências de retorno
        linhas.push(segO);
    });

    // 4. REGISTRO 5: TRAILER DE LOTE (Layout Tributos)
    contadorRegistrosLote++; // Adiciona o próprio trailer de lote na contagem
    let trailerLote = '';
    trailerLote += padZero(341, 3);                                // 001-003: Banco
    trailerLote += padZero(1, 4);                                  // 004-007: Lote
    trailerLote += '5';                                            // 008-008: Tipo Registro (5=Trailer Lote)
    trailerLote += padSpace('', 9);                                // 009-017: Brancos
    trailerLote += padZero(contadorRegistrosLote, 6);              // 018-023: Quantidade total de registros do lote
    
    const totalFinanceiroCentavos = Math.round(totalLoteFinanceiro * 100);
    trailerLote += padZero(totalFinanceiroCentavos, 18);           // 024-041: Somatória dos valores do lote
    trailerLote += padZero(0, 15);                                 // 042-056: Soma quantidade de moeda
    trailerLote += padSpace('', 174);                              // 057-230: Brancos Complemento
    trailerLote += padSpace('', 10);                               // 231-240: Ocorrências
    linhas.push(trailerLote);

    // 5. REGISTRO 9: TRAILER DE ARQUIVO
    let trailerArquivo = '';
    trailerArquivo += padZero(341, 3);                             // 001-003: Banco
    trailerArquivo += padZero(9999, 4);                            // 004-007: Código do Lote (9999 padrão)
    trailerArquivo += '9';                                         // 008-008: Tipo Registro (9=Trailer Arquivo)
    trailerArquivo += padSpace('', 9);                             // 009-017: Brancos
    trailerArquivo += padZero(1, 6);                               // 018-023: Quantidade de lotes do arquivo
    trailerArquivo += padZero(linhas.length + 1, 6);               // 024-029: Quantidade total de linhas do arquivo
    trailerArquivo += padSpace('', 211);                           // 030-240: Brancos
    linhas.push(trailerArquivo);

    // Validação de string rígida antes de salvar: cada linha deve conter EXATOS 240 caracteres
    const conteudoFinalRemessa = linhas.map((linha, index) => {
        if (linha.length !== 240) {
            throw new Error(`CRÍTICO: Linha ${index} gerada com tamanho inválido (${linha.length} bytes). O banco rejeitará o arquivo.`);
        }
        return linha;
    }).join('\r\n') + '\r\n';

    await fs.writeFile(path.join(__dirname, 'remessa.txt'), conteudoFinalRemessa, 'utf-8');
    log("🚀 Arquivo 'remessa.txt' gerado com sucesso na raiz do projeto!");
    log(`📊 Total de Linhas: ${linhas.length} | Registros processados com sucesso.`);
}

// ==========================================
// MÓDULOS DE COMUNICAÇÃO SEFAZ (MTLS E ENVIO)
// ==========================================
async function createHttpsAgent() {
    try {
        const arquivos = await fs.readdir(PASTA_CERTIFICADOS);
        const arquivoPfx = arquivos.find(file => file.toLowerCase().endsWith('.pfx'));

        if (arquivoPfx) {
            console.log(`[mTLS] Carregando certificado PFX nativamente: "${arquivoPfx}"`);
            const pfxBuffer = await fs.readFile(path.join(PASTA_CERTIFICADOS, arquivoPfx));
            return new https.Agent({
                pfx: pfxBuffer,
                passphrase: PFX_PASSPHRASE,
                keepAlive: true,
                rejectUnauthorized: false
            });
        }

        const certPath = path.join(PASTA_CERTIFICADOS, 'certificado.pem');
        const keyPath = path.join(PASTA_CERTIFICADOS, 'chave_privada.pem');
        console.log(`[mTLS] Carregando PEMs: certificado.pem e chave_privada.pem...`);
        const cert = await fs.readFile(certPath);
        const key = await fs.readFile(keyPath);

        return new https.Agent({
            cert: cert,
            key: key,
            keepAlive: true,
            rejectUnauthorized: false
        });
    } catch (error) {
        throw new Error(`Falha na infraestrutura mTLS: ${error.message}`);
    }
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

/**
 * Transforma uma lista de guias no formato XML esperado pela SEFAZ
 */
const EMITENTE_COMPLETO = {
    cnpj: "10436619000105",
    razaoSocial: "LALUA COMERCIO DE MODAS EIRELI",
    endereco: "RUA MARECHAL ANDREA 82",
    municipio: "27408", // Salvador/BA (5 dígitos conforme XSD)
    uf: "BA",
    cep: "41810105"
};

function montarXmlLote(listaGuias) {
    let xmlGuias = '';
    const hoje = new Date().toISOString().split('T')[0];
    
    for (const guia of listaGuias) {
        let xmlCamposExtras = '';
        let camposExtras = [];

        // Regras específicas de campos extras por UF favorecida
        if (guia.ufFavorecida === 'MA') {
            // Maranhão exige a chave no código 94
            camposExtras.push({ codigo: 94, valor: guia.chaveAcessoNfe });
        } else if (guia.ufFavorecida === 'MS') {
            // Mato Grosso do Sul exige a chave no código 88
            camposExtras.push({ codigo: 88, valor: guia.chaveAcessoNfe });
        } else if (guia.ufFavorecida === 'RJ') {
            // Rio de Janeiro exige data de emissão no código 117 e a chave no código 55
            camposExtras.push({ codigo: 55, valor: guia.chaveAcessoNfe });
            if (guia.dataEmissaoRJ) {
                camposExtras.push({ codigo: 117, valor: guia.dataEmissaoRJ });
            }
        } else {
            // Outras UFs usam por padrão código 55 para chave de faturamento
            if (guia.chaveAcessoNfe) {
                camposExtras.push({ codigo: 55, valor: guia.chaveAcessoNfe });
            }
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

        // Rio de Janeiro exige documento de origem no DIFAL por operação
        let xmlDocOrigem = '';
        if (guia.documentoOrigem) {
            let tipoDoc = guia.tipoDocumentoOrigem || '10';
            let numDoc = guia.documentoOrigem;
            if (guia.ufFavorecida === 'RJ') {
                tipoDoc = '24'; // CHAVE DO DFe (exigido pela SEFAZ-RJ)
                numDoc = guia.chaveAcessoNfe; // A chave de 44 dígitos
            }
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
                <CNPJ>${EMITENTE_COMPLETO.cnpj}</CNPJ>
              </identificacao>
              <razaoSocial>${EMITENTE_COMPLETO.razaoSocial}</razaoSocial>
              <endereco>${EMITENTE_COMPLETO.endereco}</endereco>
              <municipio>${EMITENTE_COMPLETO.municipio}</municipio>
              <uf>${EMITENTE_COMPLETO.uf}</uf>
              <cep>${EMITENTE_COMPLETO.cep}</cep>
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

async function enviarLote(listaGuias, agent, uf, logger) {
    const prefix = uf ? `[${uf}] ` : '';
    logger.log(`\n${prefix}=== [PASSO 1] Gerando e enviando lote de GNRE ===`);
    
    const soapXml = montarXmlLote(listaGuias);
    const timestamp = Date.now();
    
    await salvarLogXML(`envio_lote_${timestamp}_${uf || 'geral'}.xml`, soapXml, logger);

    const response = await sendSoapRequest(URL_RECEPCAO, 'processar', soapXml, agent);
    await salvarLogXML(`resposta_lote_${timestamp}_${uf || 'geral'}.xml`, response.body, logger);

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
        throw new Error("Lote rejeitado ou estrutura inválida. Verifique os arquivos na pasta xml_logs.");
    }

    logger.log(`${prefix}🚀 Lote aceito! Número do Recibo: ${reciboMatch[1]}`);
    return reciboMatch[1];
}

async function consultarLote(numeroRecibo, agent, uf, logger) {
    const prefix = uf ? `[${uf}] ` : '';
    logger.log(`${prefix}=== [PASSO 2] Consultando resultado do recibo: ${numeroRecibo} ===`);

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
        <ambiente>${MODO_PRODUCAO ? '1' : '2'}</ambiente>
        <numeroRecibo>${numeroRecibo}</numeroRecibo>
      </TConsLote_GNRE>
    </gnreDadosMsg>
  </soap12:Body>
</soap12:Envelope>`.trim();

    const response = await sendSoapRequest(URL_CONSULTA, 'consultar', soapXml, agent);
    await salvarLogXML(`resultado_consulta_${numeroRecibo}.xml`, response.body, logger);
    
    logger.log(`${prefix}✔ Resultado obtido e salvo com sucesso na pasta xml_logs!`);
    return response.body;
}

// ==========================================
// RENDERIZADOR DE GUIA EM HTML (IMPRESSÃO EM PDF)
// ==========================================

function gerarSvgI25(codigo) {
    const padroes = {
        '0': 'NNWWN', '1': 'WNNNW', '2': 'NWNNW', '3': 'WWNNN', '4': 'NNWNW',
        '5': 'WNWNN', '6': 'NWWNN', '7': 'NNNWW', '8': 'WNNWN', '9': 'NWNWN'
    };

    let bars = '1010'; // Start
    
    // Garantir número par de dígitos
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
        
        const largura = count * 1.25; // Escala do código de barras
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
        const [ano, mes, dia] = dataStr.split('-');
        return `${dia}/${mes}/${ano}`;
    }
    if (dataStr.length === 8) {
        return `${dataStr.slice(0, 2)}/${dataStr.slice(2, 4)}/${dataStr.slice(4, 8)}`;
    }
    return dataStr;
}

function formatarMoedaVisual(val) {
    return parseFloat(val || 0).toFixed(2).replace('.', ',');
}

async function exportarGuiaPDFHtml(dadosEmpresa, dadosGuia, dadosNfeExtraidos, logger) {
    const log = logger ? (msg) => logger.log(msg) : console.log;
    const ufFavorecida = dadosNfeExtraidos ? dadosNfeExtraidos.ufFavorecida : (dadosGuia.ufFavorecida || "PE");
    const codigoReceita = dadosNfeExtraidos ? dadosNfeExtraidos.codigoReceita : "100102";
    const numeroNota = dadosNfeExtraidos ? dadosNfeExtraidos.documentoOrigem : (dadosGuia.documentoOrigem || "SEM_NUMERO");
    const chaveAcessoNfe = dadosNfeExtraidos ? dadosNfeExtraidos.chaveAcessoNfe : (dadosGuia.chaveAcessoNfe || "NÃO INFORMADA");
    
    const dataVencimentoFormatada = formatarDataVisual(dadosGuia.dataVencimento);
    const valorPrincipal = formatarMoedaVisual(dadosGuia.valor);
    const valorTotal = formatarMoedaVisual(dadosGuia.valor);
    const linhaDigitavelFormatada = formatarLinhaDigitavelVisual(dadosGuia.linhaDigitavel);
    const svgBarcode = gerarSvgI25(dadosGuia.codigoBarras);

    const html = `<!DOCTYPE html>
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
                    <span class="valor">${dadosEmpresa.razaoSocial}</span><br>
                    <span class="label" style="margin-top:4px;">CNPJ</span>
                    <span>${dadosEmpresa.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}</span>
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
                    <span style="font-size: 9px; color: #555;">Guia emitida via integração Webservice GNRE v2.00.<br>Destinada ao recolhimento de DIFAL - Consumidor Final não contribuinte.</span>
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

    const nomeArquivoHtml = `guia_NF_${numeroNota}.html`;
    await fs.writeFile(path.join(PASTA_GUIAS_EMITIDAS, nomeArquivoHtml), html, 'utf-8');
    log(`📄 Guia visual gerada com sucesso: guias_emitidas/${nomeArquivoHtml}`);
}

// ==========================================
// ORQUESTRAÇÃO / MAIN EXECUTION
// ==========================================

async function processarGrupoUf(uf, notasUf, { agent, producao, simulacao, dataVencimento, dataPagamento, logger }) {
    logger.log(`[${uf}] Iniciando processamento para ${notasUf.length} nota(s) fiscal(is)...`);
    
    if (simulacao) {
        logger.log(`[${uf}] 🧪 (Modo Simulação) Gerando dados fictícios para ${notasUf.length} nota(s)...`);
        let xmlGuiasSimuladas = '';
        notasUf.forEach((nota, idx) => {
            const valorCentavos = Math.round(parseFloat(nota.valor) * 100);
            const valorFormatadoCodBarras = String(valorCentavos).padStart(11, '0');
            const dataVencLimpa = (nota.dataVencimento || '').replace(/[^0-9]/g, '');
            const codigoBarrasSimulado = `8589${valorFormatadoCodBarras}0135${dataVencLimpa || '20260620'}10436619000${idx}${nota.documentoOrigem.slice(-3)}`;
            
            xmlGuiasSimuladas += `
          <guia versao="2.00">
            <situacaoGuia>0</situacaoGuia>
            <TDadosGNRE versao="2.00">
              <ufFavorecida>${nota.ufFavorecida}</ufFavorecida>
              <tipoGnre>0</tipoGnre>
              <contribuinteEmitente>
                <identificacao>
                  <CNPJ>${nota.cnpjEmitente}</CNPJ>
                </identificacao>
                <razaoSocial>${EMITENTE_COMPLETO.razaoSocial}</razaoSocial>
                <endereco>${EMITENTE_COMPLETO.endereco}</endereco>
                <municipio>${EMITENTE_COMPLETO.municipio}</municipio>
                <uf>${EMITENTE_COMPLETO.uf}</uf>
                <cep>${EMITENTE_COMPLETO.cep}</cep>
              </contribuinteEmitente>
              <itensGNRE>
                <item>
                  <receita>${nota.codigoReceita}</receita>
                  <documentoOrigem tipo="10">${nota.documentoOrigem}</documentoOrigem>
                  <dataVencimento>${nota.dataVencimento}</dataVencimento>
                  <valor tipo="11">${nota.valor}</valor>
                  <valor tipo="21">${nota.valor}</valor>
                </item>
              </itensGNRE>
              <valorGNRE>${nota.valor}</valorGNRE>
              <dataPagamento>${nota.dataPagamento}</dataPagamento>
            </TDadosGNRE>
            <linhaDigitavel>${codigoBarrasSimulado}</linhaDigitavel>
            <codigoBarras>${codigoBarrasSimulado}</codigoBarras>
          </guia>`;
        });

        const xmlSimuladoSucesso = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <gnreRespostaMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreResultadoLote">
      <TResultLote_GNRE xmlns="http://www.gnre.pe.gov.br" versao="2.00">
        <ambiente>2</ambiente>
        <numeroRecibo>1234567890123${uf}</numeroRecibo>
        <situacaoProcess>
          <codigo>400</codigo>
          <descricao>Lote Processado</descricao>
        </situacaoProcess>
        <resultado>
          ${xmlGuiasSimuladas}
        </resultado>
      </TResultLote_GNRE>
    </gnreRespostaMsg>
  </soap12:Body>
</soap12:Envelope>`.trim();

        const nomeArquivoSimulado = `resultado_consulta_simulada_${uf}.xml`;
        await salvarLogXML(nomeArquivoSimulado, xmlSimuladoSucesso, logger);
        
        const dadosGuias = await extrairDadosGuiaXML(path.join(PASTA_LOGS, nomeArquivoSimulado));
        logger.log(`[${uf}] 🧪 (Modo Simulação) ${dadosGuias.length} guia(s) extraída(s) com sucesso.`);
        return { guias: dadosGuias, recibo: `1234567890123${uf}` };
    }

    // Fluxo real com a SEFAZ
    const recibo = await enviarLote(notasUf, agent, uf, logger);
    
    let dadosGuias = null;
    let tentativas = 0;
    const maxTentativas = 15; // 15 tentativas * 5 segundos = 75 segundos por UF

    while (tentativas < maxTentativas) {
        const segundosEspera = tentativas === 0 ? 8 : 5;
        logger.log(`[${uf}] Aguardando processamento do lote pela SEFAZ (${segundosEspera} segundos)... Tentativa ${tentativas + 1}/${maxTentativas}`);
        await sleep(segundosEspera * 1000);
        
        let xmlConsulta = '';
        try {
            xmlConsulta = await consultarLote(recibo, agent, uf, logger);
        } catch (err) {
            logger.warn(`[${uf}] ⚠ Falha na comunicação durante a consulta: ${err.message}. Re-tentando...`);
            tentativas++;
            continue;
        }
        
        const situacaoProcessXml = extrairTag(xmlConsulta, 'situacaoProcess');
        const codSituacao = situacaoProcessXml ? extrairTag(situacaoProcessXml, 'codigo') : null;
        const descSituacao = situacaoProcessXml ? extrairTag(situacaoProcessXml, 'descricao') : '';

        const estaEmProcessamento = !codSituacao || 
                                    codSituacao === '401' || 
                                    codSituacao === '103' || 
                                    codSituacao === '105' || 
                                    (descSituacao && descSituacao.toLowerCase().includes('processamento'));

        if (estaEmProcessamento) {
            logger.log(`[${uf}] ⏱ O lote ainda está em processamento na SEFAZ.`);
            tentativas++;
        } else {
            logger.log(`[${uf}] ✔ Lote processado! Extraindo dados das guias...`);
            dadosGuias = await extrairDadosGuiaXML(path.join(PASTA_LOGS, `resultado_consulta_${recibo}.xml`));
            break;
        }
    }

    if (!dadosGuias) {
        throw new Error(`O lote (Recibo: ${recibo}) excedeu o tempo limite de processamento de 75 segundos.`);
    }

    return { guias: dadosGuias, recibo: recibo };
}

async function executarFluxoCompleto({ caminhoEntrada, producao, simulacao, dataVencimento, dataPagamento, logger }) {
    await garantirPastas();
    const log = logger ? (msg) => logger.log(msg) : console.log;
    const warn = logger ? (msg) => logger.warn(msg) : console.warn;
    const error = logger ? (msg) => logger.error(msg) : console.error;
    
    let listaNotas = [];
    try {
        const stats = await fs.stat(caminhoEntrada);
        if (stats.isDirectory()) {
            const arquivos = await fs.readdir(caminhoEntrada);
            const arquivosXml = arquivos.filter(f => f.toLowerCase().endsWith('.xml'));
            
            if (arquivosXml.length > 0) {
                log(`\n📂 Lendo pasta de notas fiscais: ${caminhoEntrada}`);
                for (const arq of arquivosXml) {
                    const caminhoCompleto = path.join(caminhoEntrada, arq);
                    try {
                        const dados = await extrairDadosNfeXML(caminhoCompleto);
                        dados.caminhoOriginal = caminhoCompleto;
                        dados.nomeArquivoOriginal = arq;
                        listaNotas.push(dados);
                        log(`   ✔ Nota Fiscal Nº ${dados.documentoOrigem} (UF: ${dados.ufFavorecida}, DIFAL: R$ ${dados.valor}) carregada.`);
                    } catch (err) {
                        log(`   ⚠ Ignorado arquivo ${arq}: ${err.message}`);
                    }
                }
            }
        } else {
            const dados = await extrairDadosNfeXML(caminhoEntrada);
            dados.caminhoOriginal = caminhoEntrada;
            dados.nomeArquivoOriginal = path.basename(caminhoEntrada);
            listaNotas.push(dados);
            log(`\n✔ XML da NF-e carregado com sucesso de: ${caminhoEntrada}`);
            log(`   UF de Destino: ${dados.ufFavorecida}`);
            log(`   Valor do DIFAL: R$ ${dados.valor}`);
            log(`   Nota Fiscal: Nº ${dados.documentoOrigem}`);
        }
    } catch (err) {
        throw new Error(`Erro ao acessar notas fiscais: ${err.message}`);
    }

    if (listaNotas.length === 0) {
        throw new Error("Nenhuma nota fiscal XML válida encontrada para processamento.");
    }

    // Limpa guias antigas
    try {
        const arquivosGuias = await fs.readdir(PASTA_GUIAS_EMITIDAS);
        for (const f of arquivosGuias) {
            if (f.toLowerCase().endsWith('.html')) {
                await fs.unlink(path.join(PASTA_GUIAS_EMITIDAS, f));
            }
        }
        log("🧹 Limpeza de guias HTML antigas concluída.");
    } catch (e) {
        log(`⚠ Erro ao limpar guias antigas: ${e.message}`);
    }

    // Sobrescrever as datas de vencimento/pagamento se informadas
    const hoje = new Date().toISOString().split('T')[0];
    for (const nota of listaNotas) {
        nota.dataVencimento = dataVencimento || hoje;
        nota.dataPagamento = dataPagamento || hoje;
    }

    // Agrupar as notas por UF favorecida
    const notasPorUf = {};
    for (const nota of listaNotas) {
        if (!notasPorUf[nota.ufFavorecida]) {
            notasPorUf[nota.ufFavorecida] = [];
        }
        notasPorUf[nota.ufFavorecida].push(nota);
    }

    const ufs = Object.keys(notasPorUf);
    log(`\n🌍 UFs identificadas para processamento: ${ufs.join(', ')}`);

    const agent = simulacao ? null : await createHttpsAgent();
    
    // Processamento em paralelo de todas as UFs
    const promessas = ufs.map(async (uf) => {
        try {
            const resultadoUf = await processarGrupoUf(uf, notasPorUf[uf], {
                agent,
                producao,
                simulacao,
                dataVencimento,
                dataPagamento,
                logger
            });
            return { uf, guias: resultadoUf.guias, recibo: resultadoUf.recibo, erro: null };
        } catch (err) {
            error(`[${uf}] ❌ Falha no processamento da UF: ${err.message}`);
            return { uf, guias: [], recibo: null, erro: err.message };
        }
    });

    const resultados = await Promise.all(promessas);

    // Consolidar guias bem-sucedidas
    const todasGuias = [];
    const errosUf = {};

    for (const res of resultados) {
        if (res.erro) {
            errosUf[res.uf] = res.erro;
        } else {
            todasGuias.push(...res.guias);
        }
    }

    log(`\n=== [PROCESSO] Finalizando processamento das UFs ===`);
    log(`📊 Total de guias emitidas com sucesso: ${todasGuias.length}`);
    if (Object.keys(errosUf).length > 0) {
        warn(`⚠ UFs com falha: ${Object.entries(errosUf).map(([u, e]) => `${u} (${e})`).join(', ')}`);
    }

    if (todasGuias.length === 0) {
        throw new Error("Nenhuma guia foi emitida com sucesso em nenhuma UF. O arquivo de remessa não pôde ser gerado.");
    }

    // Corrigir e complementar os dados das guias com base nas notas originais
    for (const guia of todasGuias) {
        const notaOriginal = listaNotas.find(n => 
            (n.documentoOrigem && guia.documentoOrigem && n.documentoOrigem === guia.documentoOrigem) ||
            (n.chaveAcessoNfe && guia.chaveAcessoNfe && n.chaveAcessoNfe === guia.chaveAcessoNfe)
        );
        if (notaOriginal) {
            if (!guia.documentoOrigem || guia.documentoOrigem === 'SEM_NUMERO') {
                guia.documentoOrigem = notaOriginal.documentoOrigem;
            }
            if (!guia.chaveAcessoNfe) {
                guia.chaveAcessoNfe = notaOriginal.chaveAcessoNfe;
            }
            if (!guia.ufFavorecida) {
                guia.ufFavorecida = notaOriginal.ufFavorecida;
            }
        }
    }

    // Gerar remessa bancária e guias HTML para as bem-sucedidas
    await gerarRemessaSispag(DADOS_BANCARIOS_EMPRESA, todasGuias, logger);
    
    for (const guia of todasGuias) {
        const notaOriginal = listaNotas.find(n => n.documentoOrigem === guia.documentoOrigem);
        await exportarGuiaPDFHtml(DADOS_BANCARIOS_EMPRESA, guia, notaOriginal, logger);
    }

    // Mover os XMLs originais processados com sucesso para a pasta xml_gerados (apenas em ENVIO REAL)
    if (simulacao) {
        log("\n=== [SIMULAÇÃO] Os XMLs originais foram mantidos na pasta xml_nfe para permitir o envio real posterior. ===");
    } else {
        log("\n=== [ARQUIVAMENTO] Movendo XMLs processados com sucesso para xml_gerados ===");
        for (const guia of todasGuias) {
            const notaOriginal = listaNotas.find(n => n.documentoOrigem === guia.documentoOrigem);
            if (notaOriginal && notaOriginal.caminhoOriginal) {
                // Acha o recibo correspondente da UF usando a UF da nota original
                const resultadoUf = resultados.find(r => r.uf === notaOriginal.ufFavorecida);
                const recibo = resultadoUf ? resultadoUf.recibo : 'desconhecido';
                
                // Renomeia anexando o número do recibo
                const nomeSemExt = path.basename(notaOriginal.nomeArquivoOriginal, '.xml');
                const novoNome = `${nomeSemExt}_${recibo}.xml`;
                const caminhoDestino = path.join(PASTA_XML_GERADOS, novoNome);
                
                try {
                    await fs.rename(notaOriginal.caminhoOriginal, caminhoDestino);
                    log(`   📦 XML da Nota Fiscal ${guia.documentoOrigem} movido para xml_gerados/${novoNome}`);
                } catch (renameErr) {
                    warn(`   ⚠ Falha ao mover arquivo da nota ${guia.documentoOrigem}: ${renameErr.message}`);
                }
            }
        }
    }

    return { guias: todasGuias, erros: errosUf };
}

function obterPaginaHtml() {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lalua GNRE - Painel de Controle</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-page: #080a0f;
            --bg-card: rgba(17, 22, 34, 0.75);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-main: #f1f5f9;
            --text-secondary: #94a3b8;
            --primary: #6366f1;
            --primary-hover: #4f46e5;
            --secondary: #a855f7;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
            --accent: #06b6d4;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg-page);
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.08) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(168, 85, 247, 0.08) 0%, transparent 40%);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 40px 20px;
        }

        .container {
            width: 100%;
            max-width: 1000px;
            display: flex;
            flex-direction: column;
            gap: 24px;
        }

        header {
            text-align: center;
            margin-bottom: 12px;
        }

        header h1 {
            font-size: 32px;
            font-weight: 700;
            background: linear-gradient(135deg, #fff 30%, #a855f7 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
        }

        header p {
            color: var(--text-secondary);
            font-size: 15px;
        }

        .card {
            background: var(--bg-card);
            backdrop-filter: blur(16px);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 24px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .grid-config {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
        }

        @media (max-width: 768px) {
            .grid-config {
                grid-template-columns: 1fr;
            }
        }

        .form-group {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        label {
            font-size: 13px;
            font-weight: 600;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        input[type="date"], select {
            background: rgba(30, 41, 59, 0.5);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            color: #fff;
            padding: 12px;
            font-family: inherit;
            font-size: 15px;
            outline: none;
            transition: border-color 0.2s;
        }

        input[type="date"]:focus, select:focus {
            border-color: var(--primary);
        }

        .btn-process {
            grid-column: 1 / -1;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            border: none;
            color: #fff;
            padding: 16px;
            font-size: 16px;
            font-weight: 600;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
        }

        .btn-process:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(168, 85, 247, 0.5);
        }

        .btn-process:active {
            transform: translateY(0);
        }

        .btn-process:disabled {
            background: rgba(100, 116, 139, 0.3);
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }

        .section-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            padding-bottom: 8px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
        }

        th {
            text-align: left;
            padding: 12px;
            color: var(--text-secondary);
            font-weight: 600;
            border-bottom: 2px solid rgba(255, 255, 255, 0.05);
        }

        td {
            padding: 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.03);
        }

        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .badge-uf {
            background: rgba(6, 182, 212, 0.15);
            color: var(--accent);
        }

        .badge-valor {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 600;
        }

        .terminal {
            background: #040508;
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 16px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            line-height: 1.6;
            max-height: 250px;
            overflow-y: auto;
            color: #d1d5db;
        }

        .terminal-line {
            margin-bottom: 6px;
            white-space: pre-wrap;
        }

        .log-info { color: #d1d5db; }
        .log-success { color: var(--success); }
        .log-warning { color: var(--warning); }
        .log-error { color: var(--danger); }

        .spinner {
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255,255,255,0.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: spin 1s ease-in-out infinite;
            display: none;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .results-container {
            display: none;
            flex-direction: column;
            gap: 16px;
        }

        .download-box {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: rgba(16, 185, 129, 0.08);
            border: 1px solid rgba(10, 185, 129, 0.2);
            padding: 16px;
            border-radius: 8px;
        }

        .btn-link {
            color: var(--success);
            text-decoration: none;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: color 0.2s;
        }

        .btn-link:hover {
            color: #34d399;
        }

        .guias-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 12px;
            margin-top: 12px;
        }

        .guia-item-link {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.05);
            padding: 12px;
            border-radius: 8px;
            text-decoration: none;
            color: var(--text-main);
            display: flex;
            flex-direction: column;
            gap: 4px;
            transition: background 0.2s, border-color 0.2s;
        }

        .guia-item-link:hover {
            background: rgba(99, 102, 241, 0.08);
            border-color: rgba(99, 102, 241, 0.3);
        }

        .guia-item-link .nf-num { font-weight: 600; font-size: 14px; }
        .guia-item-link .nf-uf { color: var(--text-secondary); font-size: 12px; }

        .summary-banner {
            display: flex;
            justify-content: space-around;
            text-align: center;
            margin-bottom: 12px;
        }

        .summary-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .summary-val {
            font-size: 24px;
            font-weight: 700;
            color: var(--primary);
        }

        .summary-lbl {
            font-size: 12px;
            color: var(--text-secondary);
            text-transform: uppercase;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Lalua GNRE</h1>
            <p>Emissor de Guias e Remessas Bancárias (v2.00)</p>
        </header>

        <div class="card summary-banner">
            <div class="summary-item">
                <span class="summary-val" id="nfe-count">0</span>
                <span class="summary-lbl">Notas Carregadas</span>
            </div>
            <div class="summary-item">
                <span class="summary-val" id="total-difal">R$ 0,00</span>
                <span class="summary-lbl">Total DIFAL</span>
            </div>
        </div>

        <div class="card">
            <div class="section-title">
                <span>⚙ Configurações de Emissão</span>
            </div>
            <div class="grid-config">
                <div class="form-group">
                    <label>Ambiente de Execução</label>
                    <select id="ambiente">
                        <option value="simulado">Simulação Local (Sem Envio SEFAZ)</option>
                        <option value="producao">Produção Real (Envio Oficial SEFAZ)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Data de Vencimento</label>
                    <input type="date" id="data-vencimento">
                </div>
                <div class="form-group">
                    <label>Data de Pagamento</label>
                    <input type="date" id="data-pagamento">
                </div>
                <div class="form-group" style="justify-content: flex-end;">
                    <button class="btn-process" id="btn-processar">
                        <span class="spinner" id="spinner"></span>
                        <span id="btn-txt">Processar Notas e Emitir Lote</span>
                    </button>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="section-title">
                <span>📂 Notas Fiscais Disponíveis (xml_nfe)</span>
            </div>
            <div style="overflow-x: auto; max-height: 200px;">
                <table id="tbl-notas">
                    <thead>
                        <tr>
                            <th>Nota</th>
                            <th>UF Favorecida</th>
                            <th>Valor DIFAL</th>
                            <th>Cliente Destinatário</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td colspan="4" style="text-align: center; color: var(--text-secondary);">Carregando notas fiscais...</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div class="card" id="console-card" style="display: none;">
            <div class="section-title">
                <span>💻 Console de Execução</span>
            </div>
            <div class="terminal" id="terminal-log">
            </div>
        </div>

        <div class="card results-container" id="results-card">
            <div class="section-title">
                <span>🎉 Resultados do Processamento</span>
            </div>
            <div class="download-box">
                <div>
                    <strong style="display: block; margin-bottom: 4px;">Arquivo CNAB 240 Gerado</strong>
                    <span style="font-size: 13px; color: var(--text-secondary);">Pronto para importação no Itaú SISPAG</span>
                </div>
                <a href="/download/remessa.txt" class="btn-link" target="_blank">💾 Download remessa.txt</a>
            </div>
            <div>
                <label style="display: block; margin-bottom: 8px;">Guias de Recolhimento Emitidas (HTML)</label>
                <div class="guias-list" id="guias-lista-links">
                </div>
            </div>
        </div>
    </div>

    <script>
        const btnProcessar = document.getElementById('btn-processar');
        const btnTxt = document.getElementById('btn-txt');
        const spinner = document.getElementById('spinner');
        const selectAmbiente = document.getElementById('ambiente');
        const inputVenc = document.getElementById('data-vencimento');
        const inputPag = document.getElementById('data-pagamento');
        const tblNotasBody = document.querySelector('#tbl-notas tbody');
        const consoleCard = document.getElementById('console-card');
        const terminalLog = document.getElementById('terminal-log');
        const resultsCard = document.getElementById('results-card');
        const guiasListaLinks = document.getElementById('guias-lista-links');

        // Configura datas iniciais (hoje)
        const hoje = new Date().toISOString().split('T')[0];
        inputVenc.value = hoje;
        inputPag.value = hoje;

        // Ao alterar o vencimento, atualiza o pagamento automaticamente
        inputVenc.addEventListener('change', () => {
            inputPag.value = inputVenc.value;
        });

        // Carrega status inicial do servidor
        async function carregarStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('nfe-count').innerText = data.nfeCount;
                document.getElementById('total-difal').innerText = 'R$ ' + parseFloat(data.totalDifal).toFixed(2).replace('.', ',');

                tblNotasBody.innerHTML = '';
                if (data.notas.length === 0) {
                    tblNotasBody.innerHTML = \`<tr><td colspan="4" style="text-align: center; color: var(--text-secondary);">Nenhuma nota fiscal XML encontrada na pasta 'xml_nfe'.</td></tr>\`;
                    btnProcessar.disabled = true;
                } else {
                    btnProcessar.disabled = false;
                    data.notas.forEach(n => {
                        const tr = document.createElement('tr');
                        tr.innerHTML = \`
                            <td><strong>Nº \${n.documentoOrigem}</strong></td>
                            <td><span class="badge badge-uf">\${n.ufFavorecida}</span></td>
                            <td><span class="badge-valor">R$ \${parseFloat(n.valor).toFixed(2).replace('.', ',')}</span></td>
                            <td>\${n.destNome || 'Não Identificado'}</td>
                        \`;
                        tblNotasBody.appendChild(tr);
                    });
                }
            } catch (err) {
                console.error(err);
                tblNotasBody.innerHTML = \`<tr><td colspan="4" style="text-align: center; color: var(--danger);">Falha ao carregar notas fiscais do servidor.</td></tr>\`;
            }
        }

        carregarStatus();

        btnProcessar.addEventListener('click', async () => {
            btnProcessar.disabled = true;
            spinner.style.display = 'block';
            btnTxt.innerText = 'Processando...';
            consoleCard.style.display = 'block';
            resultsCard.style.display = 'none';
            terminalLog.innerHTML = '<div class="terminal-line log-info">Iniciando processamento do lote...</div>';

            try {
                const res = await fetch('/api/processar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ambiente: selectAmbiente.value,
                        dataVencimento: inputVenc.value,
                        dataPagamento: inputPag.value
                    })
                });

                const startResult = await res.json();
                if (!startResult.sucesso) {
                    throw new Error(startResult.erro || "Não foi possível iniciar o processamento.");
                }

                const taskId = startResult.taskId;
                
                // Polling do status da tarefa
                let lastLogCount = 0;
                const pollInterval = setInterval(async () => {
                    try {
                        const statusRes = await fetch(\`/api/status-processo?taskId=\${taskId}\`);
                        const taskData = await statusRes.json();

                        // Atualiza logs na tela incrementalmente
                        if (taskData.logs && taskData.logs.length > lastLogCount) {
                            for (let i = lastLogCount; i < taskData.logs.length; i++) {
                                const l = taskData.logs[i];
                                const line = document.createElement('div');
                                line.className = 'terminal-line log-' + l.tipo;
                                line.innerText = l.msg;
                                terminalLog.appendChild(line);
                            }
                            lastLogCount = taskData.logs.length;
                            terminalLog.scrollTop = terminalLog.scrollHeight;
                        }

                        if (taskData.status === 'concluido') {
                            clearInterval(pollInterval);
                            finalizarSucesso(taskData.guias);
                        } else if (taskData.status === 'erro') {
                            clearInterval(pollInterval);
                            finalizarErro(taskData.erro);
                        }
                    } catch (pollErr) {
                        console.error("Erro no polling:", pollErr);
                    }
                }, 2000);

                function finalizarSucesso(guias) {
                    resultsCard.style.display = 'flex';
                    guiasListaLinks.innerHTML = '';
                    guias.forEach(g => {
                        const link = document.createElement('a');
                        link.href = '/guia/' + g.documentoOrigem;
                        link.target = '_blank';
                        link.className = 'guia-item-link';
                        link.innerHTML = \`
                            <span class="nf-num">Guia NF \${g.documentoOrigem}</span>
                            <span class="nf-uf">UF: \${g.ufFavorecida} | R$ \${parseFloat(g.valor).toFixed(2).replace('.', ',')}</span>
                        \`;
                        guiasListaLinks.appendChild(link);
                    });

                    const finalLine = document.createElement('div');
                    finalLine.className = 'terminal-line log-success';
                    finalLine.innerText = '\\n✔ Processo concluído com sucesso!';
                    terminalLog.appendChild(finalLine);
                    restaurarBotoes();
                }

                function finalizarErro(erroMsg) {
                    const finalLine = document.createElement('div');
                    finalLine.className = 'terminal-line log-error';
                    finalLine.innerText = '\\n❌ Falha no processamento: ' + erroMsg;
                    terminalLog.appendChild(finalLine);
                    restaurarBotoes();
                }

                function restaurarBotoes() {
                    btnProcessar.disabled = false;
                    spinner.style.display = 'none';
                    btnTxt.innerText = 'Processar Notas e Emitir Lote';
                    carregarStatus();
                }

            } catch (err) {
                const line = document.createElement('div');
                line.className = 'terminal-line log-error';
                line.innerText = 'Erro de rede ou falha inesperada: ' + err.message;
                terminalLog.appendChild(line);
                btnProcessar.disabled = false;
                spinner.style.display = 'none';
                btnTxt.innerText = 'Processar Notas e Emitir Lote';
                carregarStatus();
            }
        });
    </script>
</body>
</html>`;
}

async function iniciarServidor() {
    const http = require('http');
    const server = http.createServer(async (req, res) => {
        // Rota principal (UI HTML)
        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(obterPaginaHtml());
        } 
        // Rota de Status (Listagem das notas na pasta)
        else if (req.method === 'GET' && req.url === '/api/status') {
            try {
                await garantirPastas();
                const arquivos = await fs.readdir(PASTA_INPUT_XML);
                const arquivosXml = arquivos.filter(f => f.toLowerCase().endsWith('.xml'));
                const notas = [];
                let totalDifal = 0;
                
                for (const arq of arquivosXml) {
                    try {
                        const dados = await extrairDadosNfeXML(path.join(PASTA_INPUT_XML, arq));
                        notas.push(dados);
                        totalDifal += parseFloat(dados.valor || 0);
                    } catch (e) {
                        // Ignora arquivos invalidos
                    }
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    nfeCount: notas.length,
                    totalDifal: totalDifal,
                    notas: notas
                }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: err.message }));
            }
        }
        // Rota de Processamento do Lote (Assíncrona)
        else if (req.method === 'POST' && req.url === '/api/processar') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const params = JSON.parse(body);
                    const producao = params.ambiente === 'producao';
                    const simulacao = params.ambiente === 'simulado';
                    const dataVencimento = params.dataVencimento;
                    const dataPagamento = params.dataPagamento;

                    // Cria ID único da tarefa
                    const taskId = `task_${Date.now()}`;
                    const logger = new TaskLogger();
                    
                    TAREFAS_ATIVAS[taskId] = {
                        status: 'processando',
                        logs: logger.logs,
                        guias: [],
                        erro: null
                    };

                    // Inicia processamento em segundo plano
                    (async () => {
                        try {
                            // Ajusta dinamicamente as URLs e ambiente global
                            MODO_PRODUCAO = producao;
                            URL_RECEPCAO = MODO_PRODUCAO
                                ? "https://www.gnre.pe.gov.br/gnreWS/services/GnreLoteRecepcao"
                                : "https://www.testegnre.pe.gov.br/gnreWS/services/GnreLoteRecepcao";
                            URL_CONSULTA = MODO_PRODUCAO
                                ? "https://www.gnre.pe.gov.br/gnreWS/services/GnreResultadoLote"
                                : "https://www.testegnre.pe.gov.br/gnreWS/services/GnreResultadoLote";

                            const resultado = await executarFluxoCompleto({
                                caminhoEntrada: PASTA_INPUT_XML,
                                producao,
                                simulacao,
                                dataVencimento,
                                dataPagamento,
                                logger
                            });

                            TAREFAS_ATIVAS[taskId].status = 'concluido';
                            TAREFAS_ATIVAS[taskId].guias = resultado.guias;
                        } catch (err) {
                            TAREFAS_ATIVAS[taskId].status = 'erro';
                            TAREFAS_ATIVAS[taskId].erro = err.message;
                            logger.error(`[CRÍTICO] Falha geral no processamento: ${err.message}`);
                        }
                    })();

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        sucesso: true,
                        taskId: taskId
                    }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ sucesso: false, erro: "Requisição inválida: " + err.message }));
                }
            });
        }
        // Nova Rota para obter Status da Tarefa
        else if (req.method === 'GET' && req.url.startsWith('/api/status-processo')) {
            try {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const taskId = url.searchParams.get('taskId');
                const tarefa = TAREFAS_ATIVAS[taskId];

                if (!tarefa) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ erro: "Tarefa não encontrada ou expirada." }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: tarefa.status,
                    logs: tarefa.logs,
                    guias: tarefa.guias,
                    erro: tarefa.erro
                }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: err.message }));
            }
        }
        // Rota de Download da Remessa
        else if (req.method === 'GET' && req.url === '/download/remessa.txt') {
            try {
                const remessaPath = path.join(__dirname, 'remessa.txt');
                const file = await fs.readFile(remessaPath);
                res.writeHead(200, { 
                    'Content-Type': 'text/plain',
                    'Content-Disposition': 'attachment; filename="remessa.txt"'
                });
                res.end(file);
            } catch (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end("Arquivo remessa.txt nao encontrado. Processe o lote primeiro.");
            }
        }
        // Rota de Visualizacao das guias HTML
        else if (req.method === 'GET' && req.url.startsWith('/guia/')) {
            try {
                const numNota = req.url.split('/')[2];
                const guiaPath = path.join(PASTA_GUIAS_EMITIDAS, `guia_NF_${numNota}.html`);
                const file = await fs.readFile(guiaPath);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(file);
            } catch (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end("Guia visual em HTML não encontrada.");
            }
        }
        else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end("Not Found");
        }
    });

    server.timeout = 360000; // Timeout de 6 minutos para conexões do navegador

    const porta = 3001;
    server.listen(porta, () => {
        console.log(`\n🚀 Interface Gráfica GNRE iniciada com sucesso!`);
        console.log(`   Acesse no navegador: http://localhost:${porta}`);
        console.log(`   (Pressione Ctrl+C no terminal para encerrar o servidor)\n`);
        
        // Abre o navegador automaticamente no Windows
        const { exec } = require('child_process');
        exec(`start http://localhost:${porta}`);
    });
}

async function main() {
    await garantirPastas();

    const nfeIndex = process.argv.indexOf('--nfe');
    const indexVenc = process.argv.indexOf('--vencimento');
    const indexPag = process.argv.indexOf('--pagamento');
    const modoProducaoArg = process.argv.includes('--producao');
    const modoTesteCnabArg = process.argv.includes('--teste-cnab');
    const modoUiArg = process.argv.includes('--ui');

    // Se nao houver flags de console de execucao imediata, assume o modo GUI (Web) por padrao
    const modoInterfaceGrafica = modoUiArg || (!modoProducaoArg && !modoTesteCnabArg);

    if (modoInterfaceGrafica) {
        await iniciarServidor();
        return;
    }

    // Fluxo CLI Direto (Terminal)
    let caminhoEntrada = PASTA_INPUT_XML;
    if (nfeIndex !== -1 && nfeIndex < process.argv.length - 1) {
        caminhoEntrada = process.argv[nfeIndex + 1];
    }

    let dataVencimientoArg = null;
    let dataPagamentoArg = null;

    if (indexVenc !== -1 && indexVenc < process.argv.length - 1) {
        dataVencimientoArg = process.argv[indexVenc + 1];
    }
    if (indexPag !== -1 && indexPag < process.argv.length - 1) {
        dataPagamentoArg = process.argv[indexPag + 1];
    }

    try {
        await executarFluxoCompleto({
            caminhoEntrada,
            producao: modoProducaoArg,
            simulacao: modoTesteCnabArg,
            dataVencimento: dataVencimientoArg,
            dataPagamento: dataPagamentoArg
        });
        console.log("\n✔ Processamento em lote via CLI finalizado com sucesso!");
    } catch (err) {
        console.error("\n❌ ERRO NA EXECUÇÃO DO FLUXO GNRE VIA CLI:");
        console.error(err.message);
        process.exit(1);
    }
}

main();
