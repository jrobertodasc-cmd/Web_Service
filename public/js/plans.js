// public/js/plans.js
// Lógica para carregamento e seleção de planos SaaS

document.addEventListener('DOMContentLoaded', async () => {
    // Carrega dados iniciais do tenant
    await carregarDados();
});

async function carregarDados() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            localStorage.removeItem('sb_access_token');
            window.location.href = '/login.html';
            return;
        }

        const data = await res.json();
        
        // Verifica se é administrador para liberar o botão de administração
        if (data.profile && data.profile.is_admin) {
            const adminLink = document.getElementById('admin-nav-link');
            if (adminLink) adminLink.classList.remove('d-none');
        }

        const tenant = Array.isArray(data.tenant) ? data.tenant[0] : data.tenant;
        const currentPlan = (tenant && tenant.subscription_status) || 'pro'; // Padrão recomendado é Pro se não setado

        // Reseta todos os cards e botões antes de marcar o ativo
        resetarCardsEBotoes();

        // Destaca o plano atual
        destacarPlanoAtivo(currentPlan);

    } catch (e) {
        showToast("Erro ao carregar dados dos planos: " + e.message, 'error');
    }
}

function resetarCardsEBotoes() {
    const plans = ['starter', 'pro', 'advanced'];
    
    plans.forEach(p => {
        const card = document.getElementById(`card-${p}`);
        if (card) {
            card.classList.remove('active-plan');
        }

        const containerBotoes = document.getElementById(`btn-${p}`).parentNode;
        if (containerBotoes) {
            containerBotoes.innerHTML = `
                <button onclick="selecionarPlano('${p}')" id="btn-${p}" class="btn ${p === 'pro' ? 'btn-primary' : 'btn-secondary'}" style="width: 100%;">
                    Selecionar Plano ${p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
            `;
        }
    });
}

function destacarPlanoAtivo(plan) {
    // Normaliza plano para 'pro' caso venha como 'ativo' (fallback)
    const activeKey = plan === 'ativo' ? 'pro' : plan;

    const card = document.getElementById(`card-${activeKey}`);
    if (card) {
        card.classList.add('active-plan');
    }

    const containerBotoes = document.getElementById(`btn-${activeKey}`)?.parentNode;
    if (containerBotoes) {
        containerBotoes.innerHTML = `
            <div class="plan-badge-active">
                <span>✔</span> Plano Ativo
            </div>
        `;
    }
}

async function selecionarPlano(plan) {
    try {
        showToast("Processando alteração de plano...", "warning");
        
        const res = await fetch('/api/tenant/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast(`Plano alterado para ${plan.toUpperCase()} com sucesso!`);
        
        // Recarrega os dados para atualizar os botões e os cards
        await carregarDados();

    } catch (e) {
        showToast("Erro ao alterar o plano: " + e.message, 'error');
    }
}
