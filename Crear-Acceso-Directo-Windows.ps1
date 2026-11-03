$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WshShell = New-Object -ComObject WScript.Shell

# 1. Acceso directo en la carpeta local
$LocalShortcut = $WshShell.CreateShortcut((Join-Path $AppDir "Centro de Control RUR.lnk"))
$LocalShortcut.TargetPath = "wscript.exe"
$LocalShortcut.Arguments = "`"$(Join-Path $AppDir 'RUR-Silent-Launcher.vbs')`""
$LocalShortcut.WorkingDirectory = $AppDir
$LocalShortcut.IconLocation = "$(Join-Path $AppDir 'public\assets\rur.ico'),0"
$LocalShortcut.Description = "Centro de Control RUR - UNIPOLI Durango"
$LocalShortcut.Save()

# 2. Acceso directo en el Escritorio del usuario
$DesktopPath = $WshShell.SpecialFolders("Desktop")
if ($DesktopPath -and (Test-Path $DesktopPath)) {
    $DesktopShortcut = $WshShell.CreateShortcut((Join-Path $DesktopPath "Centro de Control RUR.lnk"))
    $DesktopShortcut.TargetPath = "wscript.exe"
    $DesktopShortcut.Arguments = "`"$(Join-Path $AppDir 'RUR-Silent-Launcher.vbs')`""
    $DesktopShortcut.WorkingDirectory = $AppDir
    $DesktopShortcut.IconLocation = "$(Join-Path $AppDir 'public\assets\rur.ico'),0"
    $DesktopShortcut.Description = "Centro de Control RUR - UNIPOLI Durango"
    $DesktopShortcut.Save()
    Write-Host "Acceso directo de Escritorio creado: $DesktopPath\Centro de Control RUR.lnk" -ForegroundColor Green
}

Write-Host "Acceso directo local creado: $(Join-Path $AppDir 'Centro de Control RUR.lnk')" -ForegroundColor Green
