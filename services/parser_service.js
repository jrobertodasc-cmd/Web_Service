// services/parser_service.js
// Lógica de leitura de XMLs fiscais e respostas da SEFAZ

function extrairTag(xml, tagName) {
    const regex = new RegExp('<(?:[a-zA-Z0-9]+:)?' + tagName + '[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?' + tagName + '>');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
}

function extrairDadosNfeXML(xml) {
    try {
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

        // Extrai dados do destinatário
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
        
        const anoApur = dhEmi.substring(0, 4);
        const mesApur = dhEmi.substring(5, 7);
        const diaEmi = dhEmi.substring(8, 10);
        
        const dataEmissaoFormatadaRJ = dhEmi.substring(0, 10);
        const hoje = new Date().toISOString().split('T')[0];

        return {
            ufFavorecida: ufDestMatch[1],
            cnpjEmitente: emitenteMatch[1],
            codigoReceita: "100102", // DIFAL Consumidor Final
            valor: parseFloat(valorDifalMatch[1]).toFixed(2),
            dataVencimento: hoje,
            tipoDocumentoOrigem: "10", // NF-e
            documentoOrigem: numeroMatch[1],
            chaveAcessoNfe: chaveMatch[1],
            
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

function normalizarDocumentoOrigem(doc) {
    if (!doc) return "SEM_NUMERO";
    const limpo = doc.replace(/[^A-Za-z0-9]/g, '');
    if (limpo.length === 44 && /^\d+$/.test(limpo)) {
        const nfNum = parseInt(limpo.substring(25, 34), 10);
        if (!isNaN(nfNum)) {
            return String(nfNum);
        }
    }
    return limpo;
}

function extrairDadosGuiaXML(xml) {
    try {
        // Tratamento de Rejeições do lote como um todo (só se não houver guias individuais na resposta)
        if (!xml.includes('<guia') && !xml.includes(':guia')) {
            const motivoRejeicao = extrairTag(xml, 'motivoRejeicao') || extrairTag(xml, 'motivosRejeicao');
            const codigoRejeicao = extrairTag(xml, 'codigo') || extrairTag(xml, 'codigoRejeicao');
            
            if (motivoRejeicao || (codigoRejeicao && codigoRejeicao === '102')) {
                const descRejeicao = extrairTag(xml, 'descricao') || "Rejeição geral do lote";
                throw new Error(`O Lote foi rejeitado pelo governo: ${descRejeicao}`);
            }
        }

        const guias = [];
        const regexGuia = /<(?:[a-zA-Z0-9]+:)?guia[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?guia>/g;
        let matchGuia;

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
                continue;
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
            const docOrigemLimpo = normalizarDocumentoOrigem(docOrigemStr);

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

        // Se não encontrou guias em lotes, tenta como guia única
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
                const docOrigemLimpo = normalizarDocumentoOrigem(docOrigemStr);
                
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

module.exports = {
    extrairTag,
    extrairDadosNfeXML,
    extrairDadosGuiaXML
};
