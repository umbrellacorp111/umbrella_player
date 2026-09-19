Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
command = "cmd.exe /c py -3 " & Chr(34) & folder & "\start_player.pyw" & Chr(34)
shell.Run command, 0, False
