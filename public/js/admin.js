// public/js/admin.js
// Lógica do Painel Administrativo Master (Admin)

let allTenants = [];

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Valida se o usuário é administrador
    const isAdmin = await validarAcessoAdmin();
    if (!isAdmin) return;

    // 2. Carrega lista de empresas (Tenants)
    await carregarEmpresas();

    // 3. Carrega lista de usuários
    await carregarUsuarios();

    // 4. Lógica de Submissão de Cadastro de Usuário
    const createUserForm = document.getElementById('create-user-form');
    if (createUserForm) {
        createUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const name = document.getElementById('new-user-name').value;
            const email = document.getElementById('new-user-email').value;
            const password = document.getElementById('new-user-password').value;
            const tenantId = document.getElementById('new-user-tenant').value;
            const is_admin = document.getElementById('new-user-admin').checked;

            try {
                showToast("Cadastrando usuário no sistema...", 'warning');
                const res = await fetch('/api/admin/users/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, password, tenantId, is_admin })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast("Usuário cadastrado com sucesso!");
                fecharModalUsuario();
                createUserForm.reset();
                await carregarUsuarios();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 5. Lógica de Redefinição de Senha
    const resetPasswordForm = document.getElementById('reset-password-form');
    if (resetPasswordForm) {
        resetPasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const userId = document.getElementById('reset-user-id').value;
            const password = document.getElementById('reset-new-password').value;

            try {
                showToast("Redefinindo senha...", 'warning');
                const res = await fetch('/api/admin/users/reset-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, password })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast("Senha alterada com sucesso!");
                fecharModalSenha();
                resetPasswordForm.reset();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }
});

async function validarAcessoAdmin() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            localStorage.removeItem('sb_access_token');
            window.location.href = '/login.html';
            return false;
        }

        const data = await res.json();
        const tenant = Array.isArray(data.tenant) ? data.tenant[0] : data.tenant;
        if (!data.user || !tenant || !data.user.id || !tenant.id) {
             throw new Error("Dados de autenticação inválidos.");
        }
        
        // Verifica se é administrador
        if (!data.profile.is_admin) {
            showToast("Acesso negado. Apenas administradores podem acessar esta área.", 'error');
            setTimeout(() => {
                window.location.href = '/index.html';
            }, 1500);
            return false;
        }
        return true;
    } catch (e) {
        localStorage.removeItem('sb_access_token');
        window.location.href = '/login.html';
        return false;
    }
}

async function carregarEmpresas() {
    try {
        const res = await fetch('/api/admin/tenants');
        if (!res.ok) throw new Error("Erro ao carregar dados das empresas.");

        allTenants = await res.json();
        const tbody = document.getElementById('tenants-table-body');
        const selectTenant = document.getElementById('new-user-tenant');

        if (!tbody) return;

        if (allTenants.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center" style="color: var(--text-secondary);">Nenhuma empresa cadastrada.</td></tr>`;
            return;
        }

        // Popula a tabela
        tbody.innerHTML = allTenants.map(t => {
            const dataFmt = new Date(t.created_at).toLocaleDateString('pt-BR');
            const cnpFmt = t.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
            
            let statusClass = 'badge-danger';
            let statusLabel = 'Bloqueado';
            
            if (t.subscription_status === 'trial') {
                statusClass = 'badge-warning';
                statusLabel = 'Trial';
            } else if (t.subscription_status === 'starter') {
                statusClass = 'badge-success';
                statusLabel = 'Starter';
            } else if (t.subscription_status === 'pro') {
                statusClass = 'badge-success';
                statusLabel = 'Pro';
            } else if (t.subscription_status === 'advanced') {
                statusClass = 'badge-success';
                statusLabel = 'Advanced';
            } else if (t.subscription_status === 'ativo') {
                statusClass = 'badge-success';
                statusLabel = 'Ativo';
            }

            return `
                <tr>
                    <td>
                        <strong>${t.razao_social}</strong>
                        <span style="display: block; font-size: 11px; color: var(--text-secondary);">${cnpFmt}</span>
                    </td>
                    <td><span class="badge ${t.environment === 'producao' ? 'badge-success' : 'badge-warning'}">${t.environment}</span></td>
                    <td><span class="badge ${statusClass}">${statusLabel}</span></td>
                    <td>
                        <select onchange="alterarStatusEmpresa('${t.id}', this.value)" style="background: rgba(15, 20, 32, 0.9); color: var(--text-main); border: 1px solid var(--border-color); padding: 4px 8px; border-radius: 6px; font-size: 11px; cursor: pointer;">
                            <option value="inativo" ${t.subscription_status === 'inativo' ? 'selected' : ''}>🔒 Bloqueado / Inativo</option>
                            <option value="trial" ${t.subscription_status === 'trial' ? 'selected' : ''}>⏳ Trial (10 guias)</option>
                            <option value="starter" ${t.subscription_status === 'starter' ? 'selected' : ''}>Starter (100 guias)</option>
                            <option value="pro" ${t.subscription_status === 'pro' ? 'selected' : ''}>Pro (500 guias)</option>
                            <option value="advanced" ${t.subscription_status === 'advanced' ? 'selected' : ''}>Advanced (1500 guias)</option>
                            <option value="ativo" ${t.subscription_status === 'ativo' ? 'selected' : ''}>Ativo (Geral)</option>
                        </select>
                    </td>
                </tr>
            `;
        }).join('');

        // Popula o select dropdown no modal de criação de usuário
        if (selectTenant) {
            selectTenant.innerHTML = '<option value="">-- Selecione a Empresa --</option>' + allTenants.map(t => `
                <option value="${t.id}">${t.razao_social}</option>
            `).join('');
        }

    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function alterarStatusEmpresa(tenantId, status) {
    try {
        const res = await fetch('/api/admin/tenants/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenantId, status })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast("Status da empresa atualizado!");
        await carregarEmpresas();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function carregarUsuarios() {
    try {
        const res = await fetch('/api/admin/users');
        if (!res.ok) throw new Error("Falha ao carregar usuários.");

        const users = await res.json();
        const tbody = document.getElementById('users-table-body');
        if (!tbody) return;

        if (users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" class="text-center" style="color: var(--text-secondary);">Nenhum usuário cadastrado.</td></tr>`;
            return;
        }

        tbody.innerHTML = users.map(u => {
            const empresa = u.tenants ? u.tenants.razao_social : '<span style="color: var(--danger);">Sem vínculo</span>';
            const adminLabel = u.is_admin ? ' <span class="badge badge-success" style="font-size: 9px; padding: 2px 6px;">Admin Master</span>' : '';

            return `
                <tr>
                    <td>
                        <strong>${u.name}</strong>${adminLabel}
                        <span style="display: block; font-size: 12px; color: var(--text-secondary);">${u.email}</span>
                    </td>
                    <td>${empresa}</td>
                    <td>
                        <button onclick="abrirModalSenha('${u.id}', '${u.email}')" class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px;">
                            🔑 Redefinir Senha
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Controle dos Modais
function abrirModalUsuario() {
    document.getElementById('modal-user').classList.remove('d-none');
}

function fecharModalUsuario() {
    document.getElementById('modal-user').classList.add('d-none');
}

function abrirModalSenha(userId, email) {
    document.getElementById('reset-user-id').value = userId;
    document.getElementById('reset-user-email-display').textContent = email;
    document.getElementById('modal-password').classList.remove('d-none');
}

function fecharModalSenha() {
    document.getElementById('modal-password').classList.add('d-none');
}
