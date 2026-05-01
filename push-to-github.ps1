# ============================================================
# push-to-github.ps1
# Kopier filer fra Cowork working folder til GitHub-repo og push
# ============================================================
# KONFIGURER disse to stier én gang:
$WorkingFolder = "C:\Users\perfi\AppData\Roaming\Claude\local-agent-mode-sessions\2dabca3f-491c-41fd-a0a1-46971dfe629d\a2da0c64-13ed-433b-bbaf-ac0257f085cc\local_11691cb3-073b-4cb4-80c8-de4f953def45\outputs"
$RepoFolder    = "C:\Users\perfi\"   # <-- ret til din repo-sti

# ============================================================
# Filer der skal kopieres: @{ Kilde = Destination (relativ til repo) }
# Tilføj eller fjern linjer efter behov
# ============================================================
$Files = @{
    "echolima-api\src\routes\stripe.ts" = "echolima-api\src\routes\stripe.ts"
    "echolima-api\src\index.ts"         = "echolima-api\src\index.ts"
    "echolima-api\package.json"         = "echolima-api\package.json"
}

# ============================================================
# Kopier filer
# ============================================================
Write-Host "`nKopierer filer..." -ForegroundColor Cyan

foreach ($entry in $Files.GetEnumerator()) {
    $src  = Join-Path $WorkingFolder $entry.Key
    $dest = Join-Path $RepoFolder    $entry.Value
    $dir  = Split-Path $dest

    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $dest -Force
        Write-Host "  OK  $($entry.Key)" -ForegroundColor Green
    } else {
        Write-Host "  MANGLER  $src" -ForegroundColor Red
    }
}

# ============================================================
# Git commit og push
# ============================================================
Write-Host "`nGit..." -ForegroundColor Cyan
Set-Location $RepoFolder

git add .

$commitMsg = Read-Host "`nCommit-besked (Enter for default)"
if ([string]::IsNullOrWhiteSpace($commitMsg)) {
    $commitMsg = "chore: opdater filer fra Cowork"
}

git commit -m $commitMsg
git push

Write-Host "`nFaerdigt!" -ForegroundColor Green
