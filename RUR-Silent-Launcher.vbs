Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
AppDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = AppDir
WshShell.Run chr(34) & AppDir & "\RUR-Centro-de-Control.bat" & chr(34), 0, False
