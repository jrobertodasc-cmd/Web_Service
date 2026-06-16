-- schema.sql
-- Execute este script no editor SQL do seu painel do Supabase (https://supabase.com)

-- 1. Habilitar geração automática de UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Tabela de Tenants (Empresas/Assinantes)
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    cnpj VARCHAR(14) UNIQUE NOT NULL,
    razao_social VARCHAR(255) NOT NULL,
    bank_agency VARCHAR(4) NOT NULL,
    bank_account VARCHAR(5) NOT NULL,
    bank_dac VARCHAR(1) NOT NULL,
    pfx_passphrase_encrypted TEXT,
    pfx_filename VARCHAR(255),
    environment VARCHAR(20) DEFAULT 'simulado',
    subscription_status VARCHAR(20) DEFAULT 'ativo'
);

-- 3. Tabela de Perfis de Usuários (Vinculada ao Supabase Auth)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Tabela de Lotes de GNRE
CREATE TABLE IF NOT EXISTS batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
    environment VARCHAR(20) NOT NULL,
    receipt VARCHAR(1000),
    status VARCHAR(20) DEFAULT 'processando',
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Tabela de Guias Emitidas
CREATE TABLE IF NOT EXISTS guides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
    batch_id UUID REFERENCES batches(id) ON DELETE CASCADE,
    nf_number VARCHAR(50) NOT NULL,
    uf VARCHAR(2) NOT NULL,
    value NUMERIC(10, 2) NOT NULL,
    barcode VARCHAR(48),
    line_digitizable VARCHAR(48),
    storage_path TEXT, -- Link para o HTML no Supabase Storage
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. Configurar Row Level Security (RLS) para isolamento do tenant
-- O RLS é opcional se você usar a chave service_role para controle total pelo Express backend,
-- mas é recomendado se decidir conectar o frontend diretamente futuramente.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE guides ENABLE ROW LEVEL SECURITY;

-- Exemplo de Políticas Simplificadas (Caso queira estender a segurança no client-side):
-- CREATE POLICY "Permitir leitura apenas de dados do próprio tenant" ON guides
--    FOR SELECT TO authenticated USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));

-- ========================================================
-- OBSERVAÇÃO PARA O STORAGE BUCKET:
-- Você deve criar um bucket PRIVADO chamado "tenant-storage" no painel do Supabase.
-- Caminho das pastas no bucket:
--   - [tenant_id]/certificados/ (Arquivos .pfx do cliente)
--   - [tenant_id]/guias/ (Arquivos de guia em HTML)
--   - [tenant_id]/remessas/ (Arquivos de remessa CNAB remessa.txt)
-- ========================================================
