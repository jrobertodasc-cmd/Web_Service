// public/js/profile.js
// Lógica da Página de Configuração de Empresa e Certificado

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Verifica login e carrega dados atuais
    await carregarDados();

    // 2. Lógica do Formulário de Configurações Cadastrais
    const settingsForm = document.getElementById('settings-form');
    if (settingsForm) {
        settingsForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const cnpj = document.getElementById('cnpj').value;
            const razao_social = document.getElementById('razao_social').value;
            const bank_agency = document.getElementById('bank_agency').value;
            const bank_account = document.getElementById('bank_account').value;
            const bank_dac = document.getElementById('bank_dac').value;
            const environment = document.getElementById('environment').value;

            try {
                const res = await fetch('/api/tenant/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cnpj, razao_social, bank_agency, bank_account, bank_dac, environment })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast("Configurações salvas com sucesso!");
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 3. Lógica do Upload de Certificado PFX
    const pfxForm = document.getElementById('pfx-form');
    if (pfxForm) {
        pfxForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const fileInput = document.getElementById('pfx-file');
            const passphrase = document.getElementById('passphrase').value;

            if (!fileInput.files[0] || !passphrase) {
                showToast("Selecione o arquivo .pfx e digite a senha.", 'error');
                return;
            }

            const formData = new FormData();
            formData.append('pfx', fileInput.files[0]);
            formData.append('passphrase', passphrase);

            try {
                showToast("Fazendo upload do certificado...", 'warning');
                const res = await fetch('/api/tenant/upload-pfx', {
                    method: 'POST',
                    body: formData
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast("Certificado digital salvo com sucesso!");
                document.getElementById('passphrase').value = '';
                fileInput.value = '';
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }
});

async function carregarDados() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            // Se o token falhar ou expirar, manda pro login
            localStorage.removeItem('sb_access_token');
            window.location.href = '/login.html';
            return;
        }

        const data = await res.json();
        const tenant = Array.isArray(data.tenant) ? data.tenant[0] : data.tenant;
        
        // Preenche campos cadastrais/bancários
        document.getElementById('cnpj').value = (tenant && tenant.cnpj) || '';
        document.getElementById('razao_social').value = (tenant && tenant.razao_social) || '';
        document.getElementById('bank_agency').value = (tenant && tenant.bank_agency) || '';
        document.getElementById('bank_account').value = (tenant && tenant.bank_account) || '';
        document.getElementById('bank_dac').value = (tenant && tenant.bank_dac) || '';
        document.getElementById('environment').value = (tenant && tenant.environment) || 'simulado';

        // Preenche status do certificado digital PFX
        const pfxStatus = document.getElementById('pfx-status');
        if (pfxStatus) {
            if (tenant && tenant.pfx_filename) {
                pfxStatus.innerHTML = `<span style="color: var(--success);">✔ Certificado Ativo:</span> <strong>${tenant.pfx_filename}</strong>`;
            } else {
                pfxStatus.innerHTML = `<span style="color: var(--danger);">⚠ Nenhum certificado digital PFX cadastrado.</span>`;
            }
        }

        if (data.profile && data.profile.is_admin) {
            const adminLink = document.getElementById('admin-nav-link');
            if (adminLink) adminLink.classList.remove('d-none');
        }
    } catch (e) {
        showToast("Erro ao carregar dados do assinante: " + e.message, 'error');
    }
}
