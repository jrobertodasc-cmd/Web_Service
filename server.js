// server.js
// Servidor Express SaaS Multi-Tenant para Emissão de GNRE e CNAB 240

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const parserService = require('./services/parser_service');
const cnabService = require('./services/cnab_service');
const gnreService = require('./services/gnre_service');

const app = express();
const PORT = process.env.PORT || 3001;

// Configuração do cliente admin do Supabase (para operações do sistema/Storage)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Estado das tarefas ativas em processamento na memória para exibição em tempo real
const activeTasks = {};

// ==========================================
// FUNÇÕES AUXILIARES DE CRIPTOGRAFIA
// ==========================================
function getEncryptionKey(keyStr) {
    return crypto.createHash('sha256').update(String(keyStr)).digest();
}

function encrypt(text, secretKey) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', secretKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text, secretKey) {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', secretKey, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ==========================================
// MIDDLEWARE DE AUTENTICAÇÃO E MULTI-TENANCY
// ==========================================
const requireAuth = async (req, res, next) => {
    const token = req.cookies?.sb_access_token || req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: "Não autorizado. Por favor, faça login." });
    }
    
    try {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ error: "Sessão inválida ou expirada." });
        }

        // Busca o perfil e dados do tenant correspondente
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*, tenants(*)')
            .eq('id', user.id)
            .single();

        if (profileError || !profile || !profile.tenants) {
            return res.status(401).json({ error: "Perfil de usuário ou empresa não configurados." });
        }

        req.user = user;
        req.profile = profile;
        req.tenant = profile.tenants;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Erro de autenticação: " + err.message });
    }
};

const requireActiveSubscription = (req, res, next) => {
    if (req.tenant && req.tenant.subscription_status === 'inativo') {
        return res.status(403).json({ error: "Assinatura pendente ou suspensa. Regularize o pagamento para emitir novas guias." });
    }
    next();
};

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { email, password, name, cnpj, razao_social } = req.body;
    if (!email || !password || !cnpj || !razao_social) {
        return res.status(400).json({ error: "Campos obrigatórios ausentes." });
    }

    try {
        // 1. Cadastra no Supabase Auth usando a API admin (evita limite de envio de e-mails da conta gratuita)
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true
        });

        if (authError || !authData.user) {
            return res.status(400).json({ error: authError?.message || "Erro no cadastro de credenciais." });
        }

        const user = authData.user;

        // 2. Insere a empresa na tabela de tenants
        const { data: tenantData, error: tenantError } = await supabase
            .from('tenants')
            .insert({
                cnpj: cnpj.replace(/[^0-9]/g, ''),
                razao_social: razao_social,
                bank_agency: '0000',
                bank_account: '00000',
                bank_dac: '0',
                environment: 'simulado',
                subscription_status: 'ativo'
            })
            .select()
            .single();

        if (tenantError) {
            return res.status(400).json({ error: "Erro ao criar dados da empresa: " + tenantError.message });
        }

        // 3. Cria o perfil do usuário
        const { error: profileError } = await supabase
            .from('profiles')
            .insert({
                id: user.id,
                tenant_id: tenantData.id,
                email: email,
                name: name || razao_social
            });

        if (profileError) {
            return res.status(400).json({ error: "Erro ao criar perfil de usuário: " + profileError.message });
        }

        return res.status(200).json({ message: "Cadastro realizado com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "E-mail e senha são obrigatórios." });
    }

    try {
        // Cria um cliente Supabase temporário local para esta requisição de login.
        // Isso evita que o estado global do cliente "supabase" seja sobrescrito com o token do usuário logado,
        // o que faria as consultas subsequentes falharem devido ao RLS (Row Level Security).
        const tempClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });

        const { data, error } = await tempClient.auth.signInWithPassword({
            email,
            password
        });

        if (error || !data.session) {
            return res.status(401).json({ error: error?.message || "E-mail ou senha incorretos." });
        }

        // Define cookie de autenticação válido por 7 dias
        res.cookie('sb_access_token', data.session.access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: 'lax'
        });

        return res.status(200).json({ message: "Login efetuado com sucesso!", token: data.session.access_token });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('sb_access_token');
    return res.status(200).json({ message: "Logout efetuado com sucesso." });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    return res.status(200).json({
        user: {
            id: req.user.id,
            email: req.user.email,
            name: req.profile.name
        },
        profile: {
            is_admin: req.profile.is_admin,
            name: req.profile.name,
            email: req.profile.email
        },
        tenant: req.tenant
    });
});

// ==========================================
// ROTAS DE CONFIGURAÇÃO DO TENANT
// ==========================================
app.post('/api/tenant/settings', requireAuth, async (req, res) => {
    const { cnpj, razao_social, bank_agency, bank_account, bank_dac, environment } = req.body;
    if (!cnpj || !razao_social || !bank_agency || !bank_account || !bank_dac) {
        return res.status(400).json({ error: "Todos os dados cadastrais e bancários são obrigatórios." });
    }

    try {
        const { error } = await supabase
            .from('tenants')
            .update({
                cnpj: cnpj.replace(/[^0-9]/g, ''),
                razao_social: razao_social,
                bank_agency: bank_agency.replace(/[^0-9]/g, ''),
                bank_account: bank_account.replace(/[^0-9]/g, ''),
                bank_dac: bank_dac.replace(/[^0-9]/g, ''),
                environment: environment || 'simulado'
            })
            .eq('id', req.tenant.id);

        if (error) throw error;

        return res.status(200).json({ message: "Configurações atualizadas com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/tenant/upload-pfx', requireAuth, upload.single('pfx'), async (req, res) => {
    const { passphrase } = req.body;
    if (!req.file || !passphrase) {
        return res.status(400).json({ error: "Arquivo do certificado .pfx e senha são obrigatórios." });
    }

    try {
        // Sanitiza o nome do arquivo para evitar caracteres especiais, espaços, acentos e parênteses que quebram o Supabase Storage (S3)
        const rawFilename = req.file.originalname;
        const filename = rawFilename
            .normalize('NFD')                     // Remove acentos (ex: 'até' -> 'ate')
            .replace(/[\u0300-\u036f]/g, '')      // Limpa os caracteres diacríticos
            .replace(/[^a-zA-Z0-9.\-_]/g, '_');   // Substitui tudo que não for alfanumérico por underscore (_)

        // 1. Faz upload do certificado PFX para a pasta privada do tenant no storage
        const { error: uploadError } = await supabase.storage
            .from('tenant-storage')
            .upload(`${req.tenant.id}/certificados/${filename}`, req.file.buffer, {
                contentType: 'application/x-pkcs12',
                upsert: true
            });

        if (uploadError) {
            return res.status(400).json({ error: "Falha ao enviar arquivo do certificado: " + uploadError.message });
        }

        // 2. Criptografa a senha usando AES-256-CBC
        const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
        const encryptedPassphrase = encrypt(passphrase, key);

        // 3. Atualiza os dados no cadastro do tenant
        const { error: dbError } = await supabase
            .from('tenants')
            .update({
                pfx_filename: filename,
                pfx_passphrase_encrypted: encryptedPassphrase
            })
            .eq('id', req.tenant.id);

        if (dbError) throw dbError;

        return res.status(200).json({ message: "Certificado PFX cadastrado e salvo com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROTAS DE PROCESSAMENTO DE GNRE (LOTE)
// ==========================================
app.post('/api/batch/process', requireAuth, requireActiveSubscription, upload.array('files'), async (req, res) => {
    const { source, paymentDate } = req.body; // 'local' ou 'upload'
    
    try {
        let filesData = [];

        if (source === 'local') {
            // Caso escolha processar a pasta local padrão do servidor
            const pastaLocal = process.env.NODE_ENV === 'production' || process.env.VERCEL
                ? path.join('/tmp', 'xml_nfe')
                : path.join(__dirname, 'xml_nfe');
            await fs.mkdir(pastaLocal, { recursive: true });
            const arquivos = await fs.readdir(pastaLocal);
            const xmlFiles = arquivos.filter(f => f.toLowerCase().endsWith('.xml'));

            if (xmlFiles.length === 0) {
                return res.status(400).json({ error: "Nenhum arquivo XML foi localizado na pasta local 'xml_nfe'." });
            }

            for (const file of xmlFiles) {
                const filePath = path.join(pastaLocal, file);
                const content = await fs.readFile(filePath, 'utf8');
                filesData.push({
                    filename: file,
                    content: content,
                    path: filePath
                });
            }
        } else {
            // Processa arquivos enviados no corpo do formulário (SaaS)
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: "Nenhum arquivo XML foi enviado." });
            }

            filesData = req.files.map(file => ({
                filename: file.originalname,
                content: file.buffer.toString('utf8'),
                path: null
            }));
        }

        // 1. Cria um registro de lote com status 'processando'
        const { data: batch, error: batchError } = await supabase
            .from('batches')
            .insert({
                tenant_id: req.tenant.id,
                environment: req.tenant.environment,
                status: 'processando'
            })
            .select()
            .single();

        if (batchError || !batch) {
            throw new Error("Falha ao inicializar lote no banco de dados: " + batchError?.message);
        }

        // 2. Executa o processamento em background (Assíncrono / Non-blocking)
        runBatchProcessInBackground(batch.id, req.tenant, filesData, paymentDate);

        // Retorna imediatamente o identificador para o cliente fazer polling
        return res.status(200).json({
            message: "Processamento do lote iniciado com sucesso.",
            batch_id: batch.id
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/batch/status/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: batch, error } = await supabase
            .from('batches')
            .select('*, guides(*)')
            .eq('id', req.params.batchId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !batch) {
            return res.status(404).json({ error: "Lote não localizado." });
        }

        // Complementa a resposta com logs dinâmicos de memória se estiver processando
        const taskInfo = activeTasks[batch.id] || { logs: [], progress: batch.status === 'sucesso' ? 100 : 0 };

        return res.status(200).json({
            id: batch.id,
            status: batch.status,
            receipt: batch.receipt,
            error_message: batch.error_message,
            created_at: batch.created_at,
            progress: taskInfo.progress,
            logs: taskInfo.logs,
            guides: batch.guides
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Rota para consulta e importação manual de recibos (caso dê timeout)
app.post('/api/batch/query-receipt', requireAuth, async (req, res) => {
    const { receipt, uf, paymentDate } = req.body;
    if (!receipt || !uf) {
        return res.status(400).json({ error: "Número do recibo e UF são obrigatórios." });
    }

    const tenant = req.tenant;

    try {
        // 1. Carrega e prepara certificado
        if (!tenant.pfx_filename) {
            return res.status(400).json({ error: "Nenhum certificado digital PFX configurado para esta empresa." });
        }

        const passphraseKey = getEncryptionKey(process.env.ENCRYPTION_KEY);
        const passphrase = decrypt(tenant.pfx_passphrase_encrypted, passphraseKey);

        const { data: fileData, error: downloadError } = await supabase.storage
            .from('tenant-storage')
            .download(`${tenant.id}/certificados/${tenant.pfx_filename}`);

        if (downloadError || !fileData) {
            return res.status(400).json({ error: "Erro ao carregar arquivo de certificado do Storage: " + downloadError?.message });
        }

        const pfxBuffer = Buffer.from(await fileData.arrayBuffer());
        const agent = gnreService.createHttpsAgent({ pfxBuffer, passphrase });

        // 2. Consulta lote no webservice da SEFAZ
        const logsDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
            ? path.join('/tmp', 'xml_logs')
            : path.join(__dirname, 'xml_logs');

        const xmlConsulta = await gnreService.consultarLote(receipt, agent, uf, tenant.environment, logsDir);

        // 3. Extrai dados da guia e verifica status de processamento
        const sitProcess = parserService.extrairTag(xmlConsulta, 'situacaoProcess');
        const codSit = sitProcess ? parserService.extrairTag(sitProcess, 'codigo') : null;
        const descSit = sitProcess ? parserService.extrairTag(sitProcess, 'descricao') : '';

        const processando = !codSit || ['401', '103', '105'].includes(codSit) || (descSit.toLowerCase().includes('processamento') && !['402', '403', '404'].includes(codSit));

        if (processando) {
            return res.status(202).json({ 
                status: 'processando',
                message: `O lote ainda está sendo processado pelo governo do ${uf}. Tente novamente em alguns instantes.` 
            });
        }

        let dadosGuias = null;
        try {
            dadosGuias = parserService.extrairDadosGuiaXML(xmlConsulta);
        } catch (parseErr) {
            return res.status(400).json({ 
                error: `O lote foi processado, mas nenhuma guia válida foi retornada. Detalhes: ${parseErr.message}. Status: ${codSit} - ${descSit}` 
            });
        }

        if (!dadosGuias || dadosGuias.length === 0) {
            return res.status(400).json({ 
                error: `O lote foi processado, mas nenhuma guia válida foi retornada. Status: ${codSit} - ${descSit}` 
            });
        }

        // 4. Salva ou atualiza no banco de dados
        // Procura se já existe um lote com esse recibo
        const { data: existingBatch } = await supabase
            .from('batches')
            .select('*')
            .eq('tenant_id', tenant.id)
            .ilike('receipt', `%${receipt}%`)
            .limit(1);

        let batchId;
        if (existingBatch && existingBatch.length > 0) {
            batchId = existingBatch[0].id;
            
            // Atualiza status do lote existente para sucesso
            await supabase
                .from('batches')
                .update({ status: 'sucesso', receipt: `${uf}:${receipt}` })
                .eq('id', batchId);
        } else {
            // Cria um novo lote
            const { data: newBatch } = await supabase
                .from('batches')
                .insert({
                    tenant_id: tenant.id,
                    environment: tenant.environment,
                    status: 'sucesso',
                    receipt: `${uf}:${receipt}`
                })
                .select()
                .single();
            batchId = newBatch.id;
        }

        // 5. Gera HTMLs das guias, faz upload para o Storage e salva guias no BD
        const dadosBancarios = {
            cnpj: tenant.cnpj,
            razaoSocial: tenant.razao_social,
            agencia: tenant.bank_agency,
            conta: tenant.bank_account,
            dac: tenant.bank_dac
        };

        const guiasDb = [];
        for (const guia of dadosGuias) {
            // Prepara uma nota simulada para o renderizador HTML da guia
            const htmlGuia = gnreService.exportarGuiaHtml(dadosBancarios, guia, {
                cnpjEmitente: tenant.cnpj,
                razaoSocialEmitente: tenant.razao_social
            });

            const nomeLocal = `guia_NF_${guia.documentoOrigem || 'rec_importada'}.html`;
            const remotePath = `${tenant.id}/guias/${nomeLocal}`;

            await supabase.storage
                .from('tenant-storage')
                .upload(remotePath, Buffer.from(htmlGuia, 'utf-8'), {
                    contentType: 'text/html',
                    upsert: true
                });

            guiasDb.push({
                tenant_id: tenant.id,
                batch_id: batchId,
                nf_number: guia.documentoOrigem || 'N/A',
                uf: guia.ufFavorecida || uf,
                value: guia.valor,
                barcode: guia.codigoBarras,
                line_digitizable: guia.linhaDigitavel,
                storage_path: remotePath
            });
        }

        // Remove guias antigas do lote se for uma re-consulta de lote existente para não duplicar guias
        if (existingBatch && existingBatch.length > 0) {
            await supabase
                .from('guides')
                .delete()
                .eq('batch_id', batchId);
        }

        // Salva as guias importadas
        const { error: insertError } = await supabase
            .from('guides')
            .insert(guiasDb);

        if (insertError) throw insertError;

        // 5.5 Regenera o arquivo de remessa CNAB 240 consolidado
        const { data: allGuides, error: fetchGuidesError } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', batchId);

        if (fetchGuidesError) {
            console.error("Erro ao buscar guias do lote para gerar remessa:", fetchGuidesError.message);
        } else if (allGuides && allGuides.length > 0) {
            // Mapeia para o formato que gerarRemessaSispag espera
            const mappedGuides = allGuides.map(g => {
                const originalGuia = dadosGuias.find(dg => dg.codigoBarras === g.barcode);
                return {
                    codigoBarras: g.barcode,
                    valor: g.value,
                    dataVencimento: originalGuia ? originalGuia.dataVencimento : (g.created_at ? g.created_at.split('T')[0] : new Date().toISOString().split('T')[0]),
                    documentoOrigem: g.nf_number,
                    ufFavorecida: g.uf
                };
            });

            try {
                const cnabContent = cnabService.gerarRemessaSispag(dadosBancarios, mappedGuides, paymentDate);

                // Grava remessa.txt física local para compatibilidade
                const remessaLocalPath = process.env.NODE_ENV === 'production' || process.env.VERCEL
                    ? path.join('/tmp', 'remessa.txt')
                    : path.join(__dirname, 'remessa.txt');
                await fs.writeFile(remessaLocalPath, cnabContent, 'utf-8');

                // Envia remessa.txt para Supabase Storage
                const remessaFilename = `remessa_${batchId}.txt`;
                await supabase.storage
                    .from('tenant-storage')
                    .upload(`${tenant.id}/remessas/${remessaFilename}`, Buffer.from(cnabContent, 'utf-8'), {
                        contentType: 'text/plain',
                        upsert: true
                    });
            } catch (cnabErr) {
                console.error("Erro ao regenerar arquivo CNAB:", cnabErr.message);
            }
        }

        return res.status(200).json({
            status: 'sucesso',
            message: `Lote consultado com sucesso! ${dadosGuias.length} guia(s) importada(s).`,
            batch_id: batchId
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/batch/history', requireAuth, async (req, res) => {
    try {
        const { data: batches, error } = await supabase
            .from('batches')
            .select('*, guides(*)')
            .eq('tenant_id', req.tenant.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return res.status(200).json(batches);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROTAS DE DOWNLOAD DE ARQUIVOS E GUIA
// ==========================================
app.get('/api/remessa/download/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: batch, error } = await supabase
            .from('batches')
            .select('*')
            .eq('id', req.params.batchId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !batch) {
            return res.status(404).json({ error: "Lote não localizado." });
        }

        // Tenta baixar a remessa do Storage
        const remessaPath = `${req.tenant.id}/remessas/remessa_${batch.id}.txt`;
        const { data, error: downloadError } = await supabase.storage
            .from('tenant-storage')
            .download(remessaPath);

        if (downloadError || !data) {
            return res.status(404).json({ error: "Arquivo de remessa não encontrado no armazenamento." });
        }

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="remessa_${batch.id}.txt"`);
        const buffer = Buffer.from(await data.arrayBuffer());
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Suporta o download local também na raiz (remessa.txt) por compatibilidade com o script antigo
app.get('/download/remessa.txt', async (req, res) => {
    try {
        const localPath = process.env.NODE_ENV === 'production' || process.env.VERCEL
            ? path.join('/tmp', 'remessa.txt')
            : path.join(__dirname, 'remessa.txt');
        await fs.access(localPath);
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="remessa.txt"');
        return res.sendFile(localPath);
    } catch (e) {
        return res.status(404).send("Arquivo remessa.txt não localizado. Processe um lote primeiro.");
    }
});

app.get('/api/guide/download/:guideId', requireAuth, async (req, res) => {
    try {
        const { data: guide, error } = await supabase
            .from('guides')
            .select('*')
            .eq('id', req.params.guideId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !guide) {
            return res.status(404).json({ error: "Guia GNRE não encontrada." });
        }

        const { data, error: downloadError } = await supabase.storage
            .from('tenant-storage')
            .download(guide.storage_path);

        if (downloadError || !data) {
            return res.status(404).json({ error: "HTML da guia não encontrado no armazenamento." });
        }

        res.setHeader('Content-Type', 'text/html');
        const buffer = Buffer.from(await data.arrayBuffer());
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/guide/download-all/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: guides, error } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', req.params.batchId)
            .eq('tenant_id', req.tenant.id);

        if (error || !guides || guides.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para este lote." });
        }

        const AdmZip = require('adm-zip');
        const zip = new AdmZip();

        // Faz o download de cada guia em paralelo
        await Promise.all(guides.map(async (guide) => {
            try {
                const { data, error: downloadError } = await supabase.storage
                    .from('tenant-storage')
                    .download(guide.storage_path);

                if (!downloadError && data) {
                    const buffer = Buffer.from(await data.arrayBuffer());
                    const filename = `guia_NF_${guide.nf_number}_${guide.uf}.html`;
                    zip.addFile(filename, buffer);
                }
            } catch (err) {
                console.error(`Erro ao baixar guia ${guide.id} para o zip:`, err.message);
            }
        }));

        const zipBuffer = zip.toBuffer();

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="guias_lote_${req.params.batchId}.zip"`);
        return res.send(zipBuffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROTAS DO PAINEL ADMINISTRATIVO (ADMIN)
// ==========================================

// Middleware para validar se o usuário logado é administrador
const requireAdmin = (req, res, next) => {
    if (!req.profile || !req.profile.is_admin) {
        return res.status(403).json({ error: "Acesso negado. Apenas administradores podem acessar esta área." });
    }
    next();
};

// 1. Listar todas as empresas (Tenants)
app.get('/api/admin/tenants', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { data: tenants, error } = await supabase
            .from('tenants')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        return res.status(200).json(tenants);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 2. Bloquear/Desbloquear Empresa (Status da Assinatura)
app.post('/api/admin/tenants/status', requireAuth, requireAdmin, async (req, res) => {
    const { tenantId, status } = req.body; // status: 'ativo' ou 'inativo'
    if (!tenantId || !status) {
        return res.status(400).json({ error: "Empresa e status são obrigatórios." });
    }

    try {
        const { error } = await supabase
            .from('tenants')
            .update({ subscription_status: status })
            .eq('id', tenantId);

        if (error) throw error;
        return res.status(200).json({ message: `Empresa atualizada para '${status}' com sucesso!` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 3. Listar todos os usuários/perfis cadastrados com seus respectivos tenants
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { data: profiles, error } = await supabase
            .from('profiles')
            .select('*, tenants(razao_social, cnpj)')
            .order('created_at', { ascending: false });

        if (error) throw error;
        return res.status(200).json(profiles);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 4. Criar um novo usuário vinculado a uma empresa (Tenant)
app.post('/api/admin/users/create', requireAuth, requireAdmin, async (req, res) => {
    const { email, password, name, tenantId, is_admin } = req.body;
    if (!email || !password || !tenantId) {
        return res.status(400).json({ error: "E-mail, senha e empresa são obrigatórios." });
    }

    try {
        // Criação de usuário via API de Administração do Supabase Auth
        const { data: userData, error: createUserError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true
        });

        if (createUserError || !userData.user) {
            return res.status(400).json({ error: "Erro ao criar credenciais do usuário: " + (createUserError?.message || "Erro desconhecido") });
        }

        const newUser = userData.user;

        // Cria o registro na tabela profiles do banco
        const { error: profileError } = await supabase
            .from('profiles')
            .insert({
                id: newUser.id,
                tenant_id: tenantId,
                email: email,
                name: name || email.split('@')[0],
                is_admin: !!is_admin
            });

        if (profileError) {
            // Se falhar no banco, tenta remover do auth para não gerar inconsistência
            await supabase.auth.admin.deleteUser(newUser.id);
            return res.status(400).json({ error: "Erro ao criar perfil de usuário: " + profileError.message });
        }

        return res.status(200).json({ message: "Usuário criado com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 5. Redefinir senha de um usuário existente
app.post('/api/admin/users/reset-password', requireAuth, requireAdmin, async (req, res) => {
    const { userId, password } = req.body;
    if (!userId || !password) {
        return res.status(400).json({ error: "Usuário e nova senha são obrigatórios." });
    }

    try {
        // Atualiza a senha usando a API de administração do Supabase Auth
        const { error } = await supabase.auth.admin.updateUserById(userId, {
            password: password
        });

        if (error) throw error;
        return res.status(200).json({ message: "Senha redefinida com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Serve qualquer rota indefinida para o arquivo frontend padrão (SPA / fallback)
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/download')) {
        return next();
    }
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ==========================================
// MÓDULO AUXILIAR: PROCESSAMENTO EM BACKGROUND
// ==========================================
function runBatchProcessInBackground(batchId, tenant, filesData, paymentDate) {
    // Roda em paralelo sem travar o loop principal de requisições
    setImmediate(async () => {
        activeTasks[batchId] = {
            logs: [],
            progress: 5,
            status: 'processando'
        };

        const task = activeTasks[batchId];
        const log = (msg) => {
            const timestamp = new Date().toLocaleTimeString('pt-BR');
            task.logs.push(`[${timestamp}] ${msg}`);
        };

        try {
            log("🧹 Limpando buffers locais antigos...");
            task.progress = 10;

            // 1. Baixar certificado PFX
            let agent = null;
            if (tenant.environment === 'producao') {
                log("🔍 Carregando certificado PFX do armazenamento seguro...");
                if (!tenant.pfx_filename) {
                    throw new Error("Nenhum certificado digital PFX foi cadastrado na sua conta.");
                }

                const { data: pfxFile, error: downloadError } = await supabase.storage
                    .from('tenant-storage')
                    .download(`${tenant.id}/certificados/${tenant.pfx_filename}`);

                if (downloadError || !pfxFile) {
                    throw new Error("Não foi possível carregar o certificado digital do storage: " + (downloadError?.message || 'Arquivo ausente'));
                }

                const pfxBuffer = Buffer.from(await pfxFile.arrayBuffer());
                
                log("🔓 Descriptografando a senha do certificado em memória...");
                const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
                const passphrase = decrypt(tenant.pfx_passphrase_encrypted, key);

                log("⚙ Inicializando agente mTLS com a SEFAZ...");
                agent = gnreService.createHttpsAgent({ pfxBuffer, passphrase });
            } else {
                log("🧪 Modo SIMULADO ativado. O certificado digital não é necessário.");
            }

            task.progress = 25;

            // 2. Extrai notas
            log(` Lendo ${filesData.length} nota(s) fiscal(is)...`);
            const notasFiscais = [];
            for (const f of filesData) {
                try {
                    const dadosNfe = parserService.extrairDadosNfeXML(f.content);
                    dadosNfe.caminhoOriginal = f.path; // Mantém referência para exclusão/arquivamento se local
                    dadosNfe.nomeArquivoOriginal = f.filename;
                    notasFiscais.push(dadosNfe);
                    log(`   ✔ Nota Fiscal Nº ${dadosNfe.documentoOrigem} (UF: ${dadosNfe.ufFavorecida}, DIFAL: R$ ${dadosNfe.valor}) carregada.`);
                } catch (err) {
                    log(`   ⚠ Ignorado arquivo ${f.filename}: ${err.message}`);
                }
            }

            if (notasFiscais.length === 0) {
                throw new Error("Nenhum arquivo XML de NF-e válido para processamento.");
            }

            task.progress = 40;

            // Define datas de vencimento/pagamento (Padrão: Hoje, ou paymentDate se fornecido)
            const hoje = new Date().toISOString().split('T')[0];
            const dataAlvo = paymentDate || hoje;
            for (const nota of notasFiscais) {
                nota.dataVencimento = dataAlvo;
                nota.dataPagamento = dataAlvo;
            }

            // Agrupa por UF
            const notasPorUf = {};
            for (const n of notasFiscais) {
                if (!notasPorUf[n.ufFavorecida]) {
                    notasPorUf[n.ufFavorecida] = [];
                }
                notasPorUf[n.ufFavorecida].push(n);
            }

            const ufs = Object.keys(notasPorUf);
            log(`🌍 Envio dividido em ${ufs.length} UF(s): ${ufs.join(', ')}`);

            const logsDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
                ? path.join('/tmp', 'xml_logs')
                : path.join(__dirname, 'xml_logs');
            const todasGuias = [];
            const recibosEfetuados = [];
            const errosUf = {};

            task.progress = 50;

            // Processa as UFs sequencialmente para logs ordenados e robustez
            for (let i = 0; i < ufs.length; i++) {
                const uf = ufs[i];
                log(`[${uf}] Iniciando transmissão do lote...`);
                
                try {
                    let resultadoUf;
                    if (tenant.environment === 'simulado') {
                        // Modo Simulado
                        log(`[${uf}] 🧪 Simulando processamento...`);
                        let xmlGuiasSimuladas = '';
                        notasPorUf[uf].forEach((nota, idx) => {
                            const valorCentavos = Math.round(parseFloat(nota.valor) * 100);
                            const valorFormatadoCodBarras = String(valorCentavos).padStart(11, '0');
                            const codigoBarrasSimulado = `8589${valorFormatadoCodBarras}01352026062010436619000${idx}${nota.documentoOrigem.slice(-3)}`;
                            
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
                                    <razaoSocial>${tenant.razao_social}</razaoSocial>
                                    <endereco>RUA MARECHAL ANDREA 82</endereco>
                                    <municipio>27408</municipio>
                                    <uf>BA</uf>
                                    <cep>41810105</cep>
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

                        const xmlSimulado = `<?xml version="1.0" encoding="utf-8"?>
                        <soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
                          <soap12:Body>
                            <gnreRespostaMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreResultadoLote">
                              <TResultLote_GNRE xmlns="http://www.gnre.pe.gov.br" versao="2.00">
                                <ambiente>2</ambiente>
                                <numeroRecibo>999123456789${uf}</numeroRecibo>
                                <situacaoProcess>
                                  <codigo>400</codigo>
                                  <descricao>Lote Processado</descricao>
                                </situacaoProcess>
                                <resultado>${xmlGuiasSimuladas}</resultado>
                              </TResultLote_GNRE>
                            </gnreRespostaMsg>
                          </soap12:Body>
                        </soap12:Envelope>`.trim();

                        const nomeSim = `resultado_consulta_simulada_${uf}.xml`;
                        await fs.mkdir(logsDir, { recursive: true });
                        await fs.writeFile(path.join(logsDir, nomeSim), xmlSimulado, 'utf-8');

                        const guiasExt = parserService.extrairDadosGuiaXML(xmlSimulado);
                        log(`[${uf}] 🧪 Simulação concluída com sucesso!`);
                        resultadoUf = { guias: guiasExt, recibo: `999123456789${uf}` };

                    } else {
                        // Envio real
                        const recibo = await gnreService.enviarLote(notasPorUf[uf], agent, uf, tenant.environment, tenant, logsDir);
                        log(`[${uf}] Lote recebido! Recibo nº ${recibo}. Aguardando processamento da SEFAZ...`);

                        // Salva o recibo no banco imediatamente para caso dê timeout na consulta posterior
                        const itemRecibo = `${uf}:${recibo}`;
                        if (!recibosEfetuados.includes(itemRecibo)) {
                            recibosEfetuados.push(itemRecibo);
                        }
                        await supabase
                            .from('batches')
                            .update({ receipt: recibosEfetuados.join(', ') })
                            .eq('id', batchId);

                        let dadosGuias = null;
                        let tentativas = 0;
                        const maxTentativas = 30; // Aumentado de 15 para 30 tentativas (mais tempo para filas lentas)

                        while (tentativas < maxTentativas) {
                            const segundos = tentativas === 0 ? 8 : 5;
                            log(`[${uf}] Aguardando ${segundos}s (Tentativa ${tentativas + 1}/${maxTentativas})...`);
                            await new Promise(r => setTimeout(r, segundos * 1000));

                            let xmlConsulta = '';
                            try {
                                xmlConsulta = await gnreService.consultarLote(recibo, agent, uf, tenant.environment, logsDir);
                            } catch (err) {
                                log(`[${uf}] ⚠ Erro de consulta: ${err.message}. Retentando...`);
                                tentativas++;
                                continue;
                            }

                            const sitProcess = parserService.extrairTag(xmlConsulta, 'situacaoProcess');
                            const codSit = sitProcess ? parserService.extrairTag(sitProcess, 'codigo') : null;
                            const descSit = sitProcess ? parserService.extrairTag(sitProcess, 'descricao') : '';

                            const processando = !codSit || ['401', '103', '105'].includes(codSit) || (descSit.toLowerCase().includes('processamento') && !['402', '403', '404'].includes(codSit));

                            if (processando) {
                                log(`[${uf}] Lote ainda na fila de processamento governamental...`);
                                tentativas++;
                            } else {
                                log(`[${uf}] Lote processado pelo governo!`);
                                dadosGuias = parserService.extrairDadosGuiaXML(xmlConsulta);
                                break;
                            }
                        }

                        if (!dadosGuias) {
                            throw new Error("Limite de tempo esgotado aguardando retorno da SEFAZ.");
                        }

                        resultadoUf = { guias: dadosGuias, recibo };
                    }

                    todasGuias.push(...resultadoUf.guias);
                    if (resultadoUf.recibo) {
                        const itemRecibo = `${uf}:${resultadoUf.recibo}`;
                        if (!recibosEfetuados.includes(itemRecibo)) {
                            recibosEfetuados.push(itemRecibo);
                        }
                    }
                    log(`[${uf}] Lote concluído. ${resultadoUf.guias.length} guia(s) emitidas.`);

                } catch (err) {
                    log(`[${uf}] ❌ Erro de lote: ${err.message}`);
                    errosUf[uf] = err.message;
                }

                // Incrementa progresso dinamicamente
                task.progress = Math.round(50 + (30 * ((i + 1) / ufs.length)));
            }

            if (todasGuias.length === 0) {
                throw new Error("Nenhuma guia pôde ser emitida. Detalhes: " + JSON.stringify(errosUf));
            }

            // Mapeia chaves de acesso com notas originais (especial para MS/DF)
            log("🔗 Relacionando guias com as Notas Fiscais originais...");
            for (const guia of todasGuias) {
                const notaOriginal = notasFiscais.find(n => 
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

            // 3. Geração do CNAB 240
            log("Geração do arquivo de remessa CNAB 240 (Itaú SISPAG)...");
            const dadosBancarios = {
                cnpj: tenant.cnpj,
                razaoSocial: tenant.razao_social,
                agencia: tenant.bank_agency,
                conta: tenant.bank_account,
                dac: tenant.bank_dac
            };

            const cnabContent = cnabService.gerarRemessaSispag(dadosBancarios, todasGuias, paymentDate);
            
            // Grava remessa.txt física local para compatibilidade
            const remessaLocalPath = process.env.NODE_ENV === 'production' || process.env.VERCEL
                ? path.join('/tmp', 'remessa.txt')
                : path.join(__dirname, 'remessa.txt');
            await fs.writeFile(remessaLocalPath, cnabContent, 'utf-8');

            // Envia remessa.txt para Supabase Storage
            const remessaFilename = `remessa_${batchId}.txt`;
            const { error: uploadCnabError } = await supabase.storage
                .from('tenant-storage')
                .upload(`${tenant.id}/remessas/${remessaFilename}`, Buffer.from(cnabContent, 'utf-8'), {
                    contentType: 'text/plain',
                    upsert: true
                });

            if (uploadCnabError) {
                log(`⚠ Alerta: Não foi possível persistir a remessa no Storage: ${uploadCnabError.message}`);
            }

            task.progress = 90;

            // 4. Renderiza e faz upload dos arquivos de guias em HTML
            log("Gerando e enviando arquivos visuais das guias...");
            const guiasEmitidasDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
                ? path.join('/tmp', 'guias_emitidas')
                : path.join(__dirname, 'guias_emitidas');
            await fs.mkdir(guiasEmitidasDir, { recursive: true });

            for (const guia of todasGuias) {
                const nota = notasFiscais.find(n => n.documentoOrigem === guia.documentoOrigem);
                const htmlGuia = gnreService.exportarGuiaHtml(dadosBancarios, guia, nota);
                
                // Grava visual local
                const nomeLocal = `guia_NF_${guia.documentoOrigem}.html`;
                await fs.writeFile(path.join(guiasEmitidasDir, nomeLocal), htmlGuia, 'utf-8');

                // Grava visual no Storage do Supabase
                const remotePath = `${tenant.id}/guias/${nomeLocal}`;
                const { error: uploadHtmlError } = await supabase.storage
                    .from('tenant-storage')
                    .upload(remotePath, Buffer.from(htmlGuia, 'utf-8'), {
                        contentType: 'text/html',
                        upsert: true
                    });

                if (uploadHtmlError) {
                    log(`⚠ Falha no envio da guia NF ${guia.documentoOrigem} para o Storage: ${uploadHtmlError.message}`);
                } else {
                    guia.storage_path = remotePath;
                }
            }

            // 5. Arquiva arquivos XML locais se for produção real
            if (tenant.environment === 'producao') {
                log("📦 Arquivando arquivos locais de faturamento...");
                const xmlGeradosDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
                    ? path.join('/tmp', 'xml_gerados')
                    : path.join(__dirname, 'xml_gerados');
                await fs.mkdir(xmlGeradosDir, { recursive: true });

                for (const guia of todasGuias) {
                    const nota = notasFiscais.find(n => n.documentoOrigem === guia.documentoOrigem);
                    if (nota && nota.caminhoOriginal) {
                        try {
                            const nameXml = path.basename(nota.nomeArquivoOriginal, '.xml');
                            const novoCaminho = path.join(xmlGeradosDir, `${nameXml}_sucesso.xml`);
                            await fs.rename(nota.caminhoOriginal, novoCaminho);
                        } catch (e) {
                            log(`⚠ Falha ao arquivar XML local: ${e.message}`);
                        }
                    }
                }
            }

            // 6. Atualiza registro do lote e salva guias no BD
            log("Finalizando persistência de dados no Supabase...");
            const { error: updateError } = await supabase
                .from('batches')
                .update({
                    status: 'sucesso',
                    receipt: recibosEfetuados.join(', ')
                })
                .eq('id', batchId);

            if (updateError) throw updateError;

            const guidesDb = todasGuias.map(g => ({
                tenant_id: tenant.id,
                batch_id: batchId,
                nf_number: g.documentoOrigem,
                uf: g.ufFavorecida,
                value: g.valor,
                barcode: g.codigoBarras,
                line_digitizable: g.linhaDigitavel,
                storage_path: g.storage_path || null
            }));

            const { error: guidesError } = await supabase
                .from('guides')
                .insert(guidesDb);

            if (guidesError) throw guidesError;

            log("🎉 Processamento do Lote finalizado com sucesso!");
            task.progress = 100;
            task.status = 'sucesso';

        } catch (err) {
            log(`❌ Processamento falhou: ${err.message}`);
            task.status = 'erro';
            task.error = err.message;

            await supabase
                .from('batches')
                .update({
                    status: 'erro',
                    error_message: err.message
                })
                .eq('id', batchId);
        }
    });
}

// Inicializa o servidor Express apenas localmente (evita travar na Vercel serverless)
if (process.env.NODE_ENV !== 'production' && require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n==================================================`);
        console.log(`🚀 Apex GNRE SaaS rodando localmente na porta ${PORT}`);
        console.log(`🔗 Acesse: http://localhost:${PORT}`);
        console.log(`==================================================\n`);
    });
}

module.exports = app;
