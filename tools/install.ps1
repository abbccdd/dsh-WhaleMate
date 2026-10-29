$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) { throw '请先安装 DeepSeek Harness，并确保 dsh 可以运行。' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 20.3 或更高版本。' }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'DSH 插件管理需要 pnpm，请先完成 DSH 的环境配置。' }
$nodeVersion = [version]((& node -p 'process.versions.node') | Select-Object -First 1)
if ($nodeVersion -lt [version]'20.3.0') { throw 'Node.js 版本过低，请升级到 20.3 或更高版本。' }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$manifest = Join-Path $dshHome 'profiles\web\package.json'
$names = @('dsh-bili-whale','@tencent-connect/dsh-qqbot','dsh-pond')
$packages = @((Join-Path $root 'vendor\dsh-bili-whale'), (Join-Path $root 'vendor\tencent-dsh-qqbot-owner'), $root)
$installed = @{}
if (Test-Path -LiteralPath $manifest) {
  $current = Get-Content -Raw -LiteralPath $manifest -Encoding UTF8 | ConvertFrom-Json
  for ($i=0; $i -lt $names.Count; $i++) {
    $name=$names[$i]
    if ($current.dependencies -and $current.dependencies.PSObject.Properties.Name -contains $name) {
      $actual=[string]$current.dependencies.$name
      $expected='file:' + $packages[$i]
      if ($actual.Replace('\','/').TrimEnd('/') -ine $expected.Replace('\','/').TrimEnd('/')) {
        throw "已安装不同来源的 $name。为保留现有版本和配置，安装已停止；请先备份并处理旧插件。"
      }
      $installed[$name]=$true
    }
  }
}
for ($i=0; $i -lt $packages.Count; $i++) {
  $package=$packages[$i]
  if (-not (Test-Path -LiteralPath (Join-Path $package 'package.json'))) { throw "安装包不完整：$package" }
}
Write-Host '正在安装鲸伴及附带的 Bili Whale、QQ 适配器……'
for ($i=0; $i -lt $packages.Count; $i++) {
  $package=$packages[$i]
  if ($installed[$names[$i]]) { Write-Host "已安装：$($names[$i])"; continue }
  & $dsh.Source plugin --profile web add "file:$package" --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw "安装失败：$package。已安装的组件没有被自动删除。" }
}
Write-Host ''
& node (Join-Path $PSScriptRoot 'initialize.mjs')
if ($LASTEXITCODE -ne 0) { throw '初始化未完成；已有文件未覆盖，请检查错误后重试。' }
Write-Host '安装完成。请重启 DSH，在设置中完成 B 站登录、QQ 扫码和主人配对。'
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Write-Host '未检测到 FFmpeg；视频画面抽帧需要先安装 FFmpeg。' }
