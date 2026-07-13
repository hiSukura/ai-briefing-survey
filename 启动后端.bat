@echo off
chcp 65001 >nul
title AI简报问卷后端
echo.
echo ================================
echo   AI 简报 · 问卷后端启动中...
echo ================================
echo.

cd /d "%~dp0"

:: 检查 node_modules 是否存在
if not exist "node_modules\" (
    echo [1/2] 首次运行，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo 安装失败！请检查 Node.js 是否已安装。
        pause
        exit /b 1
    )
    echo.
)

echo [2/2] 启动后端服务...
echo.
echo   问卷页面: http://localhost:3000/
echo   查看结果: http://localhost:3000/api/results?pw=aibrief2026
echo.
echo   按 Ctrl+C 停止服务
echo ================================
echo.

node server.js

pause
