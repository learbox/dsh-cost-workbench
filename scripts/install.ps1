#Requires -Version 5.1
<#
.SYNOPSIS
    把「造价工作台」（dsh-cost-workbench）安装到 DeepSeek Harness。

.DESCRIPTION
    步骤：
      1. 检查 DeepSeek Harness 是否已完全退出（含托盘常驻进程）；
      2. 解析插件源码目录（默认是本脚本的上一级目录）；
      3. 调用 DSH 自带 CLI 执行 plugin --profile <profile> add <目录>（链接安装）；
      4. 打印结果与「重开 App 后生效」提示；
         失败时给出 profile patch 文件的绝对路径与手动回退步骤——只打印，不自动写。

    脚本只使用内置 cmdlet，不联网、不修改任何文件。

.PARAMETER Profile
    DSH profile 名，默认 desktop（桌面 App）。

.PARAMETER PluginDir
    插件源码目录。留空时取本脚本所在目录的上一级。

.PARAMETER DshCli
    dsh.cmd 的路径。留空时按安装目录与 PATH 自动查找。

.PARAMETER SkipProcessCheck
    跳过「App 是否已退出」的检查（仅用于在别的机器上预演，不推荐）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile web
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$PluginDir = '',
    [string]$DshCli = '',
    [switch]$SkipProcessCheck
)

$ErrorActionPreference = 'Stop'

function Write-Section([string]$text) {
    Write-Host ''
    Write-Host ('==> ' + $text) -ForegroundColor Cyan
}

function Write-Pass([string]$text) {
    Write-Host ('    [OK]   ' + $text) -ForegroundColor Green
}

function Write-Info([string]$text) {
    Write-Host ('    [..]   ' + $text)
}

function Write-Attention([string]$text) {
    Write-Host ('    [注意] ' + $text) -ForegroundColor Yellow
}

function Write-Fail([string]$text) {
    Write-Host ('    [失败] ' + $text) -ForegroundColor Red
}

# profile patch 文件（用户的 patch 层）：回退说明只打印它的绝对路径，绝不代写。
function Get-ProfilePatchPath([string]$profileName) {
    $profilesRoot = Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles'
    return (Join-Path (Join-Path $profilesRoot $profileName) 'cordis.patch.yml')
}

function Show-ManualFallback([string]$reason, [string]$cliPath) {
    $patchPath = Get-ProfilePatchPath $Profile
    $usableCli = (-not [string]::IsNullOrWhiteSpace($cliPath)) -and (Test-Path -LiteralPath $cliPath -PathType Leaf)
    Write-Host ''
    Write-Fail $reason
    Write-Host ''
    Write-Host '    手动回退说明（脚本不会替你改任何文件）：' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    1) 确认 DSH 版本为 0.2.2：'
    if ($usableCli) {
        Write-Host ('       & "' + $cliPath + '" --version')
    } else {
        Write-Host '       dsh --version'
    }
    Write-Host ''
    Write-Host '    2) 先备份 profile patch 文件（绝对路径）：'
    Write-Host ('       ' + $patchPath)
    if (Test-Path -LiteralPath $patchPath -PathType Leaf) {
        Write-Host '       该文件当前存在；复制一份带日期的副本再动手。'
    } else {
        Write-Host '       该文件当前不存在；确认 profile 名是否正确（C:\Users\<你>\.dsh\profiles\ 下应能看到同名目录）。'
    }
    Write-Host ''
    Write-Host '    3) 在该文件末尾追加一条 insert 条目（只加一次，不要重复）：'
    Write-Host ''
    Write-Host '       - insert:'
    Write-Host '           - id: dsh-cost-workbench'
    Write-Host "             name: 'dsh-cost-workbench'"
    Write-Host '             config:'
    Write-Host '               vaultRoot: "D:\Obsidian\造价工作台"'
    Write-Host '               sopDir: "00 资料库"'
    Write-Host '               workbenchDir: "Workbench"'
    Write-Host '               recordingsDir: "会议记录"'
    Write-Host ''
    Write-Host '    4) 保存后完全退出并重新启动 DeepSeek Harness。'
    Write-Host ''
    Write-Host '    也可以用 CLI 查看插件是否已登记：'
    if ($usableCli) {
        Write-Host ('       & "' + $cliPath + '" plugin --profile ' + $Profile + ' list')
    } else {
        Write-Host ('       dsh plugin --profile ' + $Profile + ' list')
    }
    Write-Host ''
    exit 1
}

try {
    # ---------------------------------------------------------------- 1. 进程检查
    Write-Section '检查 DeepSeek Harness 是否已完全退出'
    if (-not $SkipProcessCheck) {
        $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessName -like '*DeepSeek*' -or $_.ProcessName -like 'dsh*'
        })
        if ($running.Count -gt 0) {
            Write-Fail 'DeepSeek Harness 还在运行，安装不会生效。'
            Write-Host ''
            Write-Host '    正在运行的进程：' -ForegroundColor Yellow
            foreach ($proc in $running) {
                Write-Host ('      - ' + $proc.ProcessName + '  (PID ' + $proc.Id + ')')
            }
            Write-Host ''
            Write-Host '    请这样退出（只关主窗口不够，托盘进程仍在）：'
            Write-Host '      1. 右键任务栏托盘里的 DeepSeek Harness 图标 → 退出；'
            Write-Host '      2. 打开任务管理器 → 详细信息，确认没有 DeepSeek 相关进程残留；'
            Write-Host '      3. 重新运行本脚本。'
            Write-Host ''
            Write-Attention '如果确认已经没有窗口却仍报占用，可加 -SkipProcessCheck 再运行一次。'
            exit 2
        }
        Write-Pass '没有检测到运行中的 DeepSeek Harness 进程。'
    } else {
        Write-Attention '已跳过进程检查（-SkipProcessCheck）。请自行确认 App 已完全退出。'
    }

    # ------------------------------------------------------ 2. 解析插件源码目录
    Write-Section '解析插件源码目录'
    if ([string]::IsNullOrWhiteSpace($PluginDir)) {
        $scriptDir = $PSScriptRoot
        if ([string]::IsNullOrWhiteSpace($scriptDir)) {
            $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
        }
        $PluginDir = Split-Path -Parent $scriptDir
    }
    if (-not (Test-Path -LiteralPath $PluginDir -PathType Container)) {
        Show-ManualFallback ('插件源码目录不存在：' + $PluginDir) ''
    }
    $PluginDir = (Resolve-Path -LiteralPath $PluginDir).ProviderPath

    $pkgFile = Join-Path $PluginDir 'package.json'
    if (-not (Test-Path -LiteralPath $pkgFile -PathType Leaf)) {
        Show-ManualFallback ('目录里没有 package.json，看起来不是插件源码目录：' + $PluginDir) ''
    }
    $pkgName = ''
    try {
        $pkg = Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $pkgName = [string]$pkg.name
    } catch {
        Show-ManualFallback ('package.json 读不出来或不是合法 JSON：' + $pkgFile) ''
    }
    if ($pkgName -ne 'dsh-cost-workbench') {
        Show-ManualFallback ('package.json 的 name 是 "' + $pkgName + '"，不是 dsh-cost-workbench；目录可能指错了。') ''
    }
    foreach ($required in @('index.js', 'client.js', 'cordis.patch.yml')) {
        if (-not (Test-Path -LiteralPath (Join-Path $PluginDir $required) -PathType Leaf)) {
            Show-ManualFallback ('插件目录缺少 ' + $required + '：' + $PluginDir) ''
        }
    }
    Write-Pass ('插件目录：' + $PluginDir)
    Write-Info ('包名：' + $pkgName + '，版本：' + [string]$pkg.version)

    # ------------------------------------------------------------- 3. 定位 CLI
    Write-Section '定位 DeepSeek Harness 的命令行工具'
    if ([string]::IsNullOrWhiteSpace($DshCli)) {
        $candidates = @()
        if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
        }
        if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
            $candidates += (Join-Path $env:USERPROFILE 'AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
        }
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $DshCli = $candidate
                break
            }
        }
        if ([string]::IsNullOrWhiteSpace($DshCli)) {
            $found = Get-Command 'dsh.cmd' -ErrorAction SilentlyContinue
            if ($null -ne $found) {
                $DshCli = [string]$found.Source
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($DshCli) -or -not (Test-Path -LiteralPath $DshCli -PathType Leaf)) {
        Show-ManualFallback ('找不到 dsh.cmd。请用 -DshCli 指定它的完整路径。') $DshCli
    }
    $DshCli = (Resolve-Path -LiteralPath $DshCli).ProviderPath
    Write-Pass ('CLI：' + $DshCli)
    Write-Info ('目标 profile：' + $Profile)

    # --------------------------------------------------------- 4. 执行安装命令
    Write-Section '执行链接安装（dsh plugin add）'
    $arguments = @('plugin', '--profile', $Profile, 'add', $PluginDir)
    Write-Info ('命令：& "' + $DshCli + '" ' + ($arguments -join ' '))
    Write-Host ''

    $exitCode = 1
    Push-Location -LiteralPath $PluginDir
    try {
        & $DshCli @arguments
        $exitCode = $LASTEXITCODE
    } catch {
        Write-Fail ('调用 CLI 时出错：' + $_.Exception.Message)
        $exitCode = 1
    } finally {
        Pop-Location
    }

    # ------------------------------------------------------------- 5. 汇总结果
    if ($null -eq $exitCode) {
        $exitCode = 0
    }

    if ($exitCode -ne 0) {
        Show-ManualFallback ('安装命令退出码为 ' + $exitCode + '（非 0）。') $DshCli
    }

    Write-Pass ('安装命令执行成功（退出码 ' + $exitCode + '）。')
    Write-Host ''
    Write-Host '    下一步（必须做）：' -ForegroundColor Yellow
    Write-Host '      1. 完全退出 DeepSeek Harness（含托盘），再重新启动；'
    Write-Host '         不重启 App 的话，工作台不会挂上去。'
    Write-Host '      2. 打开任意会话，点标题右侧的造价工作台图标，或按 Alt+W。'
    Write-Host '      3. 第一次打开会问 Obsidian 库路径，填：'
    Write-Host '         D:\Obsidian\造价工作台'
    Write-Host '      4. 如果这个库还没建，先运行同目录的 seed-vault.ps1 生成种子内容。'
    Write-Host ''
    Write-Info '工作台数据留在 Obsidian 库与 C:\Users\<你>\.dsh-workbench 下，卸载不会删除。'
    Write-Host ''
    exit 0
} catch {
    Write-Host ''
    Write-Fail ('脚本异常终止：' + $_.Exception.Message)
    Write-Host '    如仍无法安装，请按上面「手动回退说明」检查 profile patch 与 DSH 版本。' -ForegroundColor Yellow
    exit 1
}
