// public/js/dashboard.js
// Lógica do Painel de Faturamento e Processamento de Lotes

let selectedFiles = [];
let pollingInterval = null;

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Verifica login e carrega cabeçalho/empresa
    await carregarDadosDashboard();

    // 2. Carrega histórico de lotes
    await carregarHistoricoLotes();

    // 3. Inicializa drag-and-drop no dropzone
    const dropzone = document.getElementById('xml-dropzone');
    const xmlInput = document.getElementById('xml-input');

    if (dropzone && xmlInput) {
        dropzone.addEventListener('click', () => xmlInput.click());

        xmlInput.addEventListener('change', (e) => {
            adicionarArquivos(e.target.files);
        });

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            adicionarArquivos(e.dataTransfer.files);
        });
    }

    // 4. Lógica de Envio por Upload
    const btnProcessUpload = document.getElementById('btn-process-upload');
    if (btnProcessUpload) {
        btnProcessUpload.addEventListener('click', async () => {
            if (selectedFiles.length === 0) {
                showToast("Por favor, selecione ou arraste pelo menos um XML de nota fiscal.", 'error');
                return;
            }

            const paymentDate = document.getElementById('payment-date').value;
            const formData = new FormData();
            selectedFiles.forEach(file => {
                formData.append('files', file);
            });
            formData.append('source', 'upload');
            formData.append('paymentDate', paymentDate);

            try {
                resetTerminal();
                showToast("Enviando notas fiscais para o lote...", 'warning');
                btnProcessUpload.disabled = true;

                const res = await fetch('/api/batch/process', {
                    method: 'POST',
                    body: formData
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                selectedFiles = [];
                atualizarListaArquivosVisual();
                iniciarPollingLote(data.batch_id);

            } catch (err) {
                showToast(err.message, 'error');
                btnProcessUpload.disabled = false;
            }
        });
    }

    // 5. Lógica de Processamento de Pasta Local
    const btnProcessLocal = document.getElementById('btn-process-local');
    if (btnProcessLocal) {
        btnProcessLocal.addEventListener('click', async () => {
            try {
                resetTerminal();
                showToast("Iniciando varredura da pasta local 'xml_nfe'...", 'warning');
                btnProcessLocal.disabled = true;

                const paymentDate = document.getElementById('payment-date').value;
                const res = await fetch('/api/batch/process', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source: 'local', paymentDate })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                iniciarPollingLote(data.batch_id);

            } catch (err) {
                showToast(err.message, 'error');
                btnProcessLocal.disabled = false;
            }
        });
    }
});

// Adiciona arquivos do input/drop à lista local na memória
function adicionarArquivos(files) {
    const listDiv = document.getElementById('selected-files');
    
    for (let file of files) {
        if (file.type === 'text/xml' || file.name.toLowerCase().endsWith('.xml')) {
            // Evita arquivos repetidos com o mesmo nome
            if (!selectedFiles.some(f => f.name === file.name)) {
                selectedFiles.push(file);
            }
        }
    }

    atualizarListaArquivosVisual();
}

function atualizarListaArquivosVisual() {
    const listDiv = document.getElementById('selected-files');
    if (!listDiv) return;

    if (selectedFiles.length === 0) {
        listDiv.classList.add('d-none');
        listDiv.innerHTML = '';
        return;
    }

    listDiv.classList.remove('d-none');
    listDiv.innerHTML = selectedFiles.map((file, idx) => `
        <div class="file-item">
            <span>📄 ${file.name} (${(file.size / 1024).toFixed(1)} KB)</span>
            <span class="remove-file" onclick="removerArquivo(${idx})">✖</span>
        </div>
    `).join('');
}

function removerArquivo(idx) {
    selectedFiles.splice(idx, 1);
    atualizarListaArquivosVisual();
}

function resetTerminal() {
    const term = document.getElementById('terminal-logs');
    if (term) {
        term.innerHTML = '<span class="log-line">Inicializando terminal de lote...</span>';
    }
    const prog = document.getElementById('processing-progress');
    if (prog) prog.classList.remove('d-none');
    setProgresso(0);
    const spXmlBtn = document.getElementById('download-sp-xml-btn');
    if (spXmlBtn) spXmlBtn.classList.add('d-none');
}

function setProgresso(perc) {
    const inner = document.getElementById('progress-inner');
    const valText = document.getElementById('progress-val');
    if (inner && valText) {
        inner.style.width = `${perc}%`;
        valText.textContent = `${perc}%`;
    }
}

// Inicia polling para acompanhar o progresso e logs do processamento em background
function iniciarPollingLote(batchId) {
    if (pollingInterval) clearInterval(pollingInterval);

    pollingInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/batch/status/${batchId}`);
            if (!res.ok) throw new Error("Erro ao buscar status do processamento.");

            const data = await res.json();
            
            // 1. Atualiza barra de progresso
            setProgresso(data.progress || 0);

            // 2. Atualiza os logs do terminal
            const term = document.getElementById('terminal-logs');
            if (term && data.logs && data.logs.length > 0) {
                term.innerHTML = data.logs.map(line => `
                    <div class="log-line">${line}</div>
                `).join('');
                term.scrollTop = term.scrollHeight; // Auto scroll down
            }

            // 3. Finalização
            if (data.status === 'sucesso' || data.status === 'erro') {
                clearInterval(pollingInterval);
                pollingInterval = null;

                // Re-habilita botões
                document.getElementById('btn-process-upload').disabled = false;
                document.getElementById('btn-process-local').disabled = false;

                if (data.status === 'sucesso') {
                    showToast("Lote processado com sucesso!");
                    await carregarHistoricoLotes();
                    await carregarDetalhesLote(batchId);
                } else {
                    showToast("O lote apresentou falhas: " + data.error_message, 'error');
                    await carregarHistoricoLotes();
                }
            }

        } catch (err) {
            clearInterval(pollingInterval);
            pollingInterval = null;
            document.getElementById('btn-process-upload').disabled = false;
            document.getElementById('btn-process-local').disabled = false;
            showToast("Falha na sincronização do lote: " + err.message, 'error');
        }
    }, 1200);
}

async function carregarDadosDashboard() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            localStorage.removeItem('sb_access_token');
            window.location.href = '/login.html';
            return;
        }

        const data = await res.json();
        const tenant = Array.isArray(data.tenant) ? data.tenant[0] : data.tenant;
        
        document.getElementById('tenant-name').textContent = data.user.name;
        document.getElementById('active-env').textContent = (tenant && tenant.environment === 'producao') ? '🚀 Produção' : '🧪 Simulado';
        document.getElementById('active-env').className = (tenant && tenant.environment === 'producao') ? 'badge badge-success' : 'badge badge-warning';
        
        // CNPJ formatado
        const cnpj = (tenant && tenant.cnpj) || '';
        document.getElementById('company-cnpj').textContent = cnpj.length === 14 
            ? cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
            : cnpj;

        // Inicializa as datas de pagamento com o dia de hoje
        const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split('/').reverse().join('-');
        const paymentDateInput = document.getElementById('payment-date');
        if (paymentDateInput) paymentDateInput.value = hoje;
        const reciboPaymentDateInput = document.getElementById('recibo-payment-date');
        if (reciboPaymentDateInput) reciboPaymentDateInput.value = hoje;

        if (data.profile && data.profile.is_admin) {
            const adminLink = document.getElementById('admin-nav-link');
            if (adminLink) adminLink.classList.remove('d-none');
        }
    } catch (e) {
        showToast("Erro ao carregar dados do dashboard: " + e.message, 'error');
    }
}

async function carregarHistoricoLotes() {
    try {
        const res = await fetch('/api/batch/history');
        if (!res.ok) throw new Error();

        const data = await res.json();
        const tbody = document.getElementById('history-table-body');
        if (!tbody) return;

        if (data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center" style="color: var(--text-secondary);">Nenhum lote enviado ainda.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(batch => {
            const dataFmt = new Date(batch.created_at).toLocaleString('pt-BR');
            let badgeClass = 'badge-warning';
            let statusText = 'Processando';
            if (batch.status === 'sucesso') {
                badgeClass = 'badge-success';
                statusText = 'Sucesso';
            } else if (batch.status === 'erro') {
                badgeClass = 'badge-danger';
                statusText = 'Falha';
            }

            return `
                <tr style="cursor: pointer;" onclick="carregarDetalhesLote('${batch.id}')">
                    <td>${dataFmt}</td>
                    <td><span class="badge ${batch.environment === 'producao' ? 'badge-success' : 'badge-warning'}">${batch.environment}</span></td>
                    <td><span class="badge ${badgeClass}">${statusText}</span></td>
                    <td>
                        <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px;">Ver Detalhes</button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (e) {
        showToast("Falha ao carregar histórico de lotes.", 'error');
    }
}

async function carregarDetalhesLote(batchId) {
    try {
        const res = await fetch(`/api/batch/status/${batchId}`);
        if (!res.ok) throw new Error();

        const batch = await res.json();
        const detailsSection = document.getElementById('batch-details-section');
        const guidesBody = document.getElementById('guides-table-body');
        const remessaBtn = document.getElementById('download-remessa-btn');
        const guiasAllBtn = document.getElementById('download-guias-all-btn');
        const spXmlBtn = document.getElementById('download-sp-xml-btn');

        if (!detailsSection || !guidesBody) return;

        if (batch.status !== 'sucesso') {
            detailsSection.classList.add('d-none');
            return;
        }

        detailsSection.classList.remove('d-none');
        remessaBtn.href = `/api/remessa/download/${batch.id}`;
        if (guiasAllBtn) {
            guiasAllBtn.href = `/api/guide/download-all/${batch.id}`;
        }
        if (spXmlBtn) {
            if (batch.has_sp_xml) {
                spXmlBtn.href = `/api/batch/download-xml/${batch.id}`;
                spXmlBtn.classList.remove('d-none');
            } else {
                spXmlBtn.classList.add('d-none');
            }
        }
        const receiptsContainer = document.getElementById('batch-receipts-container');
        if (receiptsContainer) {
            receiptsContainer.textContent = batch.receipt ? `Recibos: ${batch.receipt}` : '';
        }

        if (!batch.guides || batch.guides.length === 0) {
            guidesBody.innerHTML = `<tr><td colspan="4" class="text-center" style="color: var(--text-secondary);">Nenhuma guia vinculada a este lote.</td></tr>`;
            return;
        }

        guidesBody.innerHTML = batch.guides.map(g => {
            const isPdf = g.storage_path && g.storage_path.toLowerCase().endsWith('.pdf');
            const isSpPending = g.barcode === 'IMPORTAR_NO_SEFAZ_SP';
            
            let actionBtn = '';
            if (isSpPending) {
                actionBtn = `<button class="btn btn-secondary" disabled style="padding: 4px 8px; font-size: 11px; opacity: 0.65; cursor: not-allowed; border-color: var(--warning); color: var(--warning);" title="As guias de São Paulo não são geradas via Web Service de transmissão direta. Baixe o lote XML de SP e envie-o no portal da SEFAZ-SP.">
                                ⏳ Pendente SEFAZ-SP
                             </button>`;
            } else {
                const btnText = isPdf ? '📄 Abrir Guia PDF' : '📄 Abrir Guia HTML';
                actionBtn = `<a href="/api/guide/download/${g.id}" target="_blank" class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px;">
                                ${btnText}
                             </a>`;
            }

            const badgeStyle = isSpPending ? 'background: #e6a23c; color: #fff;' : '';

            return `
                <tr>
                    <td>NF ${g.nf_number}</td>
                    <td><span class="badge ${isSpPending ? '' : 'badge-success'}" style="${badgeStyle}">${g.uf}</span></td>
                    <td>R$ ${parseFloat(g.value).toFixed(2).replace('.', ',')}</td>
                    <td>
                        ${actionBtn}
                    </td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        showToast("Erro ao abrir detalhes do lote.", 'error');
    }
}

// Funções para controle do Modal de Consulta de Recibo Manual
function abrirModalRecibo() {
    const modal = document.getElementById('modal-recibo');
    if (modal) modal.classList.add('show');
}

function fecharModalRecibo() {
    const modal = document.getElementById('modal-recibo');
    if (modal) modal.classList.remove('show');
    const form = document.getElementById('form-consulta-recibo');
    if (form) form.reset();
}

async function enviarConsultaRecibo(event) {
    event.preventDefault();
    const uf = document.getElementById('recibo-uf').value;
    const receipt = document.getElementById('recibo-numero').value;
    const paymentDate = document.getElementById('recibo-payment-date').value;
    const btnSubmit = document.getElementById('btn-submit-recibo');

    if (!uf || !receipt) {
        showToast("UF e número do recibo são obrigatórios.", "error");
        return;
    }

    try {
        btnSubmit.disabled = true;
        const originalText = btnSubmit.textContent;
        btnSubmit.textContent = "Consultando...";
        showToast("Consultando recibo na SEFAZ...", "warning");

        const token = localStorage.getItem('sb_access_token');
        const res = await fetch('/api/batch/query-receipt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ receipt, uf, paymentDate })
        });

        const data = await res.json();
        
        if (res.status === 202) {
            showToast(data.message, "warning");
            return;
        }

        if (!res.ok) {
            throw new Error(data.error || "Erro desconhecido ao consultar recibo.");
        }

        showToast(data.message || "Recibo consultado e guias importadas com sucesso!", "success");
        fecharModalRecibo();
        
        // Recarrega o histórico e abre detalhes do lote atualizado
        await carregarHistoricoLotes();
        if (data.batch_id) {
            await carregarDetalhesLote(data.batch_id);
        }
    } catch (err) {
        showToast(err.message, "error");
    } finally {
        btnSubmit.disabled = false;
        btnSubmit.textContent = "Consultar e Resgatar";
    }
}

