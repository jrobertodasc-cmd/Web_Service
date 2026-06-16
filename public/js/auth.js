// public/js/auth.js
// Lógica de Autenticação do Cliente SaaS

// Interceptador global do fetch para injetar o token JWT do Supabase
const originalFetch = window.fetch;
window.fetch = async function (resource, options = {}) {
    const url = typeof resource === 'string' ? resource : (resource ? resource.url : '');
    if (url && (url.startsWith('/api/') || url.includes('/api/'))) {
        const token = localStorage.getItem('sb_access_token');
        if (token) {
            if (!options.headers) {
                options.headers = {};
            }
            if (options.headers instanceof Headers) {
                options.headers.set('Authorization', `Bearer ${token}`);
            } else {
                options.headers['Authorization'] = `Bearer ${token}`;
            }
        }
    }
    return originalFetch(resource, options);
};

const toast = document.getElementById('toast');

function showToast(message, type = 'success') {
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show toast-${type}`;
    setTimeout(() => {
        toast.className = 'toast';
    }, 4000);
}

// Lógica de Cadastro
const registerForm = document.getElementById('register-form');
if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const name = document.getElementById('name').value;
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const cnpj = document.getElementById('cnpj').value;
        const razao_social = document.getElementById('razao_social').value;

        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password, cnpj, razao_social })
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Falha no cadastramento.');
            }

            showToast("Cadastro realizado com sucesso! Redirecionando...", 'success');
            setTimeout(() => {
                window.location.href = '/login.html';
            }, 1500);
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
}

// Lógica de Login
const loginForm = document.getElementById('login-form');
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'E-mail ou senha incorretos.');
            }

            // Armazena no localStorage para facilidade do frontend
            localStorage.setItem('sb_access_token', data.token);

            showToast("Login bem-sucedido! Acessando painel...", 'success');
            setTimeout(() => {
                window.location.href = '/index.html';
            }, 1000);
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
}

// Função de Logoff global
async function logout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        localStorage.removeItem('sb_access_token');
        window.location.href = '/login.html';
    } catch (e) {
        window.location.href = '/login.html';
    }
}
