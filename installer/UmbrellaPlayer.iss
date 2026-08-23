#define AppName "Umbrella Player"
#define AppVersion "1.0.5"
#define AppExeName "Umbrella Player.exe"

[Setup]
AppId={{D1B0C43A-5C6A-4A83-93FA-UMBRELLAPLAYER}}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
OutputDir=..\release
OutputBaseFilename=UmbrellaPlayer-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\{#AppExeName}

[Files]
Source: "..\dist\Umbrella Player.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\Umbrella Player Updater.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"
