@echo off
title Enviar Apex GNRE para GitHub
chcp 65001 > nul

echo ===================================================
echo 🚀 Enviando o código para o GitHub...
echo ===================================================
echo.

REM Garante que o Git está inicializado e configurado
git init > nul 2>&1
git remote remove origin > nul 2>&1
git remote add origin https://github.com/jrobertodasc-cmd/Web_Service

REM Adiciona os arquivos e cria o commit
echo [1/3] Adicionando arquivos ao commit...
git add .
git commit -m "feat: migrate to saas and vercel serverless architecture with admin panel" > nul 2>&1
git branch -M main

echo.
echo [2/3] Enviando para o repositório remoto (main)...
echo ⚠ Uma tela de login do GitHub pode surgir para você autorizar a conta "jrobertodasc-cmd".
echo.
git push -u origin main --force

echo.
echo ===================================================
if %errorlevel% equ 0 (
    echo ✔ CÓDIGO ENVIADO COM SUCESSO!
    echo Agora você pode voltar ao painel da Vercel e dar Deploy.
) else (
    echo ❌ FALHA AO ENVIAR PARA O GITHUB.
    echo Verifique se você está logado na conta correta do GitHub no navegador.
)
echo ===================================================
echo.
pause
