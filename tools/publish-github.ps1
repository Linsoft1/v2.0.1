$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')
$package = Get-Content -Raw (Join-Path (Get-Location) 'package.json') | ConvertFrom-Json
$version = [string]$package.version
$tag = "v$version"
$publish = $package.build.publish
if ($publish.provider -ne 'github' -or !$publish.owner -or !$publish.repo) {
  throw 'GitHub publish target is missing from package.json.'
}
$remote = "https://github.com/$($publish.owner)/$($publish.repo).git"
$publishPaths = @(
  '.github', '.gitignore', 'README.md', 'RELEASE_CHECKLIST.md',
  'Linsoft centrum app', 'app.js', 'index.html', 'main.cjs',
  'package-lock.json', 'package.json', 'preload.cjs', 'styles.css',
  'assets', 'packaging', 'scripts', 'tools'
)

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Git príkaz zlyhal: git $($Arguments -join ' ') (kód $LASTEXITCODE)"
  }
}

$branch = (& git branch --show-current).Trim()
if ($branch -ne 'main') {
  throw "Publish from main only; current branch is '$branch'."
}

$configuredRemote = & git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0) {
  Invoke-Git @('remote', 'add', 'origin', $remote)
} elseif ($configuredRemote.TrimEnd('/') -ne $remote.TrimEnd('/')) {
  throw "Origin points to '$configuredRemote', not the configured release target '$remote'."
}

# Remove previously staged dependency output without deleting the local install.
Invoke-Git @('rm', '-r', '--cached', '--ignore-unmatch', '--', 'node_modules')
Invoke-Git (@('add', '-A', '--') + $publishPaths)

$pending = & git status --porcelain -- $publishPaths
if ($pending) {
  Invoke-Git (@('commit', '-m', "Linsoft Browser $tag", '--') + $publishPaths)
}

Invoke-Git @('push', '-u', 'origin', 'main')

$tagExists = & git tag --list $tag
if (-not $tagExists) {
  Invoke-Git @('tag', $tag)
}
Invoke-Git @('push', 'origin', $tag)

Write-Host ''
Write-Host 'Hotovo. Skontroluj GitHub Actions:' -ForegroundColor Green
Write-Host "https://github.com/$($publish.owner)/$($publish.repo)/actions"