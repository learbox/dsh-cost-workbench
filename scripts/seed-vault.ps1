#Requires -Version 5.1
<#
.SYNOPSIS
    幂等创建「造价工作台」Obsidian 库与种子文件。

.DESCRIPTION
    在指定目录下创建：
      00 资料库\01 计价依据\         + 计价依据索引.md
      00 资料库\02 招投标流程\       + 招投标流程.md
      00 资料库\03 合同与索赔\       + 合同与索赔要点.md
      00 资料库\04 常用模板\         + 常用模板清单.md
      会议记录\
      Workbench\术语表.md            30 条造价中英术语
      Workbench\计价依据.md          5 条示例
      Workbench\材料价格.md          表头 + 2 条空示例
      Workbench\变更签证台账.md      表头 + 0 条数据
      Workbench\.backups\

    幂等：已存在的目录与文件一律跳过，绝不覆盖用户改动。
    写盘编码为 UTF-8（无 BOM），与 lib/table.js 的解析/序列化格式对齐：
    首行 # 标题 → 空行 → 说明段 → 空行 → Markdown 表格（表头 + 分隔行 + 数据行）。

    脚本只使用内置 cmdlet，不联网。

.PARAMETER VaultPath
    Obsidian 库根目录，默认 %USERPROFILE%\Obsidian\造价工作台；已有库请用 -VaultPath 指定。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\seed-vault.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\seed-vault.ps1 -VaultPath "C:\你的Obsidian库\造价工作台"
#>
[CmdletBinding()]
param(
    [string]$VaultPath = (Join-Path $env:USERPROFILE 'Obsidian\造价工作台')
)

$ErrorActionPreference = 'Stop'

$script:fileCreated = 0
$script:fileSkipped = 0
$script:dirCreated = 0
$script:dirSkipped = 0
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Section([string]$text) {
    Write-Host ''
    Write-Host ('==> ' + $text) -ForegroundColor Cyan
}

function New-DirectoryIfMissing([string]$path) {
    if (Test-Path -LiteralPath $path -PathType Container) {
        Write-Host ('  [跳过] ' + $path + '（已存在）')
        $script:dirSkipped++
        return
    }
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    Write-Host ('  [创建] ' + $path)
    $script:dirCreated++
}

function Write-SeedFile([string]$path, [string]$content) {
    if (Test-Path -LiteralPath $path) {
        Write-Host ('  [跳过] ' + $path + '（已存在，不覆盖）')
        $script:fileSkipped++
        return
    }
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        $script:dirCreated++
    }
    # 统一成 LF 换行，并保证文件以恰好一个换行结尾：
    # 与 lib/table.js 的 serialize（lines.join('\n')）口径一致，避免 5.1 的 here-string 带出 CRLF 或吞掉结尾换行。
    $normalized = $content -replace "`r`n", "`n"
    $normalized = $normalized.TrimEnd([char]10) + "`n"
    [System.IO.File]::WriteAllText($path, $normalized, $utf8NoBom)
    Write-Host ('  [创建] ' + $path)
    $script:fileCreated++
}

try {
    Write-Host ''
    Write-Host '造价工作台 · 种子数据' -ForegroundColor Green
    Write-Host ('目标库：' + $VaultPath)

    # ------------------------------------------------------------- 目录
    Write-Section '创建目录'
    New-DirectoryIfMissing $VaultPath
    New-DirectoryIfMissing (Join-Path $VaultPath '00 资料库')
    New-DirectoryIfMissing (Join-Path $VaultPath '00 资料库\01 计价依据')
    New-DirectoryIfMissing (Join-Path $VaultPath '00 资料库\02 招投标流程')
    New-DirectoryIfMissing (Join-Path $VaultPath '00 资料库\03 合同与索赔')
    New-DirectoryIfMissing (Join-Path $VaultPath '00 资料库\04 常用模板')
    New-DirectoryIfMissing (Join-Path $VaultPath '会议记录')
    New-DirectoryIfMissing (Join-Path $VaultPath 'Workbench')
    New-DirectoryIfMissing (Join-Path $VaultPath 'Workbench\.backups')

    # ------------------------------------------------------- 术语表（30 条）
    Write-Section '写入 Workbench\术语表.md'
    $glossary = @'
# 造价中英术语表

由工作台维护。清单、定额、合同、招投标里的中英对照都记在这里；新增、修改、删除都在工作台里做，落盘即生效，也可以直接编辑本文件，保持下面这张表即可。

| 中文 | 英文 | 领域 | 标签 | 备注 |
| --- | --- | --- | --- | --- |
| 工程量清单 | Bill of Quantities | 造价 | 清单, 计量 | 招标文件的组成部分，按 GB 50500 编制，是投标报价与结算的基础 |
| 综合单价 | Comprehensive Unit Price | 造价 | 组价, 单价 | 含人工、材料、机械、管理费、利润及一定范围风险费用 |
| 措施项目费 | Measure Project Cost | 造价 | 费用, 措施 | 为完成工程采取的技术、安全、环保等措施所发生的费用 |
| 暂列金额 | Provisional Sum | 造价 | 清单, 暂列 | 招标人预留、用于未确定或不可预见事项的金额，由招标人掌握使用 |
| 暂估价 | Provisional Price | 造价 | 清单, 暂估 | 必然发生但暂时不能确定价格的材料、设备或专业工程 |
| 计日工 | Daywork | 造价 | 清单, 零星 | 按日计价的零星用工、材料与机械，用于清单外的小量工作 |
| 总承包服务费 | General Contractor Service Fee | 造价 | 费用, 总包 | 总承包人为分包工程提供协调、配合服务而收取的费用 |
| 规费 | Statutory Fee | 造价 | 费用, 规费 | 按规定必须计取的费用，如社会保险费、住房公积金等 |
| 税金 | Tax | 造价 | 费用, 税金 | 工程造价中的增值税销项税额，税率随政策调整 |
| 变更 | Variation | 造价 | 合同, 变更 | 合同履行期间对工程范围、数量、质量或做法的调整 |
| 签证 | Site Instruction | 造价 | 合同, 签证 | 对现场事实、工程量或费用的书面确认，常与变更配套使用 |
| 索赔 | Claim | 造价 | 合同, 索赔 | 因非己方原因造成损失或工期延误而提出的补偿主张 |
| 结算 | Settlement | 造价 | 结算, 支付 | 对已完成工程价款的阶段性或最终核定 |
| 招标控制价 | Tender Control Price | 造价 | 招标, 控制价 | 招标人设定的最高投标限价，超过即按废标处理 |
| 不平衡报价 | Unbalanced Bid | 造价 | 投标, 报价 | 总价基本不变，抬高早期结算子目单价、压低后期子目单价的策略 |
| 评标基准价 | Bid Evaluation Benchmark Price | 造价 | 评标, 基准价 | 评标时用于计算价格得分的基准，常取有效报价的某种平均值 |
| FIDIC | FIDIC | 造价 | 合同, 国际 | 国际咨询工程师联合会发布的合同条件体系，常用于国际工程 |
| 工期延长 | Extension of Time | 造价 | 合同, 工期 | 因非承包商原因导致的工期顺延，通常简称 EOT |
| 中期付款证书 | Interim Payment Certificate | 造价 | 合同, 付款 | 按工程进度签发的阶段付款凭证，简称 IPC |
| 清单漏项 | Missing Item | 造价 | 清单, 风险 | 清单未列而图纸或规范要求完成的工作，需按合同约定处理 |
| 甲供材料 | Owner-Supplied Material | 造价 | 采购, 材料 | 由发包人采购供应、承包人负责保管与使用的材料 |
| 索赔时效 | Time Bar for Claims | 造价 | 合同, 时效 | 合同约定的索赔提出期限，逾期可能丧失索赔权利 |
| 取费基数 | Fee Calculation Base | 造价 | 组价, 费率 | 计取管理费、利润、规费等费用所依据的计算基数 |
| 定额 | Quota | 造价 | 定额, 计价 | 规定完成单位合格产品所需人工、材料、机械消耗量的标准 |
| 信息价 | Information Price | 造价 | 材料, 价格 | 造价管理机构定期发布的地区材料指导价格 |
| 工程量偏差 | Quantity Deviation | 造价 | 清单, 结算 | 实际完成量与清单量的差额，超过约定幅度时按合同调整单价 |
| 不可抗力 | Force Majeure | 造价 | 合同, 风险 | 不能预见、不能避免且不能克服的客观情况，按合同约定分担损失 |
| 缺陷责任期 | Defects Liability Period | 造价 | 合同, 保修 | 工程交付后承包人对缺陷负责修复的期限，通常与质保金挂钩 |
| 单价合同 | Unit Price Contract | 造价 | 合同, 计价 | 按实际完成工程量乘以合同单价结算的合同形式 |
| 竣工结算 | Completion Settlement | 造价 | 结算, 竣工 | 工程竣工后编制的最终价款结算文件，需经审核确认 |
'@
    Write-SeedFile (Join-Path $VaultPath 'Workbench\术语表.md') $glossary

    # --------------------------------------------------- 计价依据（5 条示例）
    Write-Section '写入 Workbench\计价依据.md'
    $standards = @'
# 计价依据速查

由工作台维护：清单计价规范、消耗量定额、面积计算规则、合同示范文本等都可记在这里。也可以直接编辑本文件，保持下面表格的格式即可。

| 编号 | 名称 | 类别 | 版本文号 | 实施日期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| GB50500-2013 | 建设工程工程量清单计价规范 | 国家标准 | GB 50500-2013 | 2013-07-01 | 清单计价的核心规范，配套各专业工程量计算规范使用 |
| GB/T50353-2013 | 建筑工程建筑面积计算规范 | 国家标准 | GB/T 50353-2013 | 2014-07-01 | 建筑面积的计算口径，影响单位造价与措施费基数 |
| TY01-31-2015 | 房屋建筑与装饰工程消耗量定额 | 全国统一定额 | TY 01-31-2015 | 2015-12-01 | 全国统一消耗量定额，各省一般据此编制地方定额；日期以正式发布文件为准 |
| 省定额 | ××省建设工程计价定额 | 地方定额 | 以各省发布为准 | 以各省发布为准 | 示例行：按项目所在省份替换名称、文号与实施日期 |
| GF-2017-0201 | 建设工程施工合同（示范文本） | 合同示范文本 | GF-2017-0201 | 2017-10-01 | 住建部与工商总局联合发布，价款调整、变更与索赔条款的常用依据 |
'@
    Write-SeedFile (Join-Path $VaultPath 'Workbench\计价依据.md') $standards

    # ------------------------------------------- 材料价格（表头 + 2 条空示例）
    Write-Section '写入 Workbench\材料价格.md'
    $prices = @'
# 材料价格库

记录询价与信息价，便于组价和变更签证取证。同一种材料在不同地区分开记；同一主键重复新增会被拒绝。

| 材料 | 规格 | 单位 | 单价 | 地区 | 日期 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
'@
    Write-SeedFile (Join-Path $VaultPath 'Workbench\材料价格.md') $prices

    # --------------------------------------------- 变更签证台账（表头 + 0 条）
    Write-Section '写入 Workbench\变更签证台账.md'
    $changes = @'
# 变更签证台账

变更、签证、索赔的流水账。编号建议沿用项目内部编号（如 BG-001），状态可写「待审批 / 已批准 / 已结算 / 已驳回」。

| 编号 | 项目 | 事由 | 金额 | 日期 | 状态 |
| --- | --- | --- | --- | --- | --- |
'@
    Write-SeedFile (Join-Path $VaultPath 'Workbench\变更签证台账.md') $changes

    # ----------------------------------------------------- 资料库起始笔记
    Write-Section '写入 00 资料库 起始笔记'

    $stdIndex = @'
# 计价依据索引

本目录放项目用到的计价依据与依据摘要。与 `Workbench/计价依据.md` 的表格配合使用：
表格记文号与生效日期，笔记记适用范围和本项目实际采用的版本。

## 常用依据

- **GB 50500-2013** 建设工程工程量清单计价规范：清单编制、报价、结算的总规则
- **GB/T 50353-2013** 建筑工程建筑面积计算规范：建筑面积的计算口径
- **房屋建筑与装饰工程消耗量定额 TY 01-31-2015**：全国统一消耗量定额
- **各省建设工程计价定额**：实际组价以项目所在省的地方定额为准
- **GF-2017-0201** 建设工程施工合同（示范文本）：价款调整、变更、索赔与结算条款

## 本项目的选择

- 项目所在省市：
- 采用的定额版本与文号：
- 信息价发布周期：
- 合同约定的调价方式：

## 使用提醒

1. 先定依据版本再组价；同一个项目不要混用两版定额。
2. 信息价有发布周期，跨期结算要按合同约定取价。
3. 地方文件与国家标准不一致时，按合同约定的优先顺序处理。
'@
    Write-SeedFile (Join-Path $VaultPath '00 资料库\01 计价依据\计价依据索引.md') $stdIndex

    $tender = @'
# 招投标流程

## 五步骨架

1. **招标准备**：立项与资金落实、图纸与技术要求、编制招标控制价、确定招标方式与标段划分。
2. **发布招标信息**：发布招标公告或资格预审公告、发售招标文件、组织现场踏勘与答疑澄清。
3. **投标**：投标人编制投标文件、缴纳保证金、密封递交；注意投标截止时间与补充文件。
4. **开标评标定标**：开标唱标、评标委员会评审（资格、商务、技术、价格）、推荐中标候选人并公示。
5. **签约与备案**：发出中标通知书、签订合同、退还保证金、按规定备案。

## 每一步的造价关注点

| 步骤 | 关注点 |
| --- | --- |
| 招标准备 | 控制价编制依据是否齐全；清单项目特征描述是否清楚 |
| 发布信息 | 答疑澄清是否改变清单或合同条款；补充文件是否影响报价 |
| 投标 | 不平衡报价风险；暂列金额、暂估价、计日工是否按招标文件填报 |
| 开标评标 | 评标基准价与价格分规则；低于成本报价的认定 |
| 签约备案 | 合同价与中标价一致性；付款、变更、结算条款是否清晰 |

## 时间节点

- 招标文件发售起止：
- 投标截止时间：
- 开标时间：
- 中标通知书发出：
'@
    Write-SeedFile (Join-Path $VaultPath '00 资料库\02 招投标流程\招投标流程.md') $tender

    $contract = @'
# 合同与索赔要点

## 合同里先看这几条

- **计价方式**：固定总价 / 单价合同 / 可调价 / 成本加酬金，决定结算怎么做。
- **价款调整**：材料调差范围与基准期、工程量偏差调整幅度、政策性调整。
- **变更与签证**：谁有权发出指令、书面形式、计价原则、时限。
- **索赔**：索赔事件、通知期限、证据要求、工期与费用的计算方式。
- **结算与支付**：结算期限、审核期限、质保金比例与返还时点。

## 索赔四步

1. **发通知**：在合同约定期限内书面通知，说明事件与影响（注意索赔时效）。
2. **留证据**：现场记录、影像、往来函件、会议纪要、监理签认、气象与停水停电记录。
3. **算损失**：费用按实际发生或合同约定口径计算；工期用网络计划分析关键线路影响。
4. **报报告**：最终报告含事实、依据条款、计算过程、证据清单与结论。

## 常见争议点

- 变更与索赔界线不清：先定性，再定量。
- 工期延误由多方原因造成：按责任比例或关键线路分担。
- 签证只有事实没有计价：补签计价原则。
- 材料价格调整的基准期与信息价期次错位。

## 本项目记录

- 合同编号：
- 索赔时效条款：
- 已发生的变更与索赔：
'@
    Write-SeedFile (Join-Path $VaultPath '00 资料库\03 合同与索赔\合同与索赔要点.md') $contract

    $templates = @'
# 常用模板清单

本目录放项目上反复要用的空白模板。需要时复制一份改名使用。

## 清单

- [ ] 工程变更单（变更事由、内容、工程量、计价依据、工期影响）
- [ ] 现场签证单（事实描述、工程量、单价、金额、影像编号）
- [ ] 索赔意向通知书（事件、时间线、初步影响、后续报告时间）
- [ ] 索赔报告（事实、合同依据、费用与工期计算、证据清单）
- [ ] 材料询价单（材料、规格、单位、含税价、交货期、有效期）
- [ ] 进度款申请（已完成工程量、累计支付、本期应付）
- [ ] 竣工结算书（结算汇总、变更签证汇总、争议项说明）
- [ ] 会议纪要（时间、参会人、议定事项、待办与责任人）

## 使用约定

- 模板只保留结构，不写示例金额，避免误用。
- 对外文件统一编号（如 BG-001、QZ-001、SP-001），与 `Workbench/变更签证台账.md` 对齐。
- 重要文件发出前留一份 PDF 存档。
'@
    Write-SeedFile (Join-Path $VaultPath '00 资料库\04 常用模板\常用模板清单.md') $templates

    # ------------------------------------------------------------- 汇总
    Write-Section '结果汇总'
    Write-Host ('  目录：新建 ' + $script:dirCreated + ' 个，已存在 ' + $script:dirSkipped + ' 个')
    Write-Host ('  文件：新建 ' + $script:fileCreated + ' 个，已存在跳过 ' + $script:fileSkipped + ' 个')
    Write-Host ''
    Write-Host '    下一步：' -ForegroundColor Yellow
    Write-Host '      1. 用 Obsidian 打开这个文件夹作为库（如果还没有库）：'
    Write-Host ('         ' + $VaultPath)
    Write-Host '      2. 完全退出并重开 DeepSeek Harness（如果还没装插件，先运行 install.ps1）。'
    Write-Host '      3. 打开工作台，第一次会问库路径，填上面这个目录。'
    Write-Host ''
    Write-Host '  说明：本脚本幂等，重复运行只会补缺失的目录与文件，不会覆盖已有内容。' -ForegroundColor Green
    Write-Host ''
    exit 0
} catch {
    Write-Host ''
    Write-Host ('[失败] 种子数据创建中断：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '  已创建的部分会保留；修正问题后重新运行即可（已存在的文件会被跳过）。' -ForegroundColor Yellow
    exit 1
}
