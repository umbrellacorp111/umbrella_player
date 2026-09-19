# -*- mode: python ; coding: utf-8 -*-

import os


a = Analysis(
    ['SOVAKOD\\main.py'],
    pathex=[os.path.abspath('SOVAKOD'),],
    binaries=[],
    datas=[('SOVAKOD\\index.html', '.'), ('SOVAKOD\\styles.css', '.'), ('SOVAKOD\\spring-ui.js', '.'), ('SOVAKOD\\silk-aurora.js', '.'), ('SOVAKOD\\app2.js', '.'), ('SOVAKOD\\archaeo.js', '.'), ('SOVAKOD\\eternalbox.html', '.'), ('SOVAKOD\\hls.min.js', '.'), ('SOVAKOD\\gsap.min.js', '.')],
    hiddenimports=['server', 'app_version', 'app_updater', 'yt_dlp_updater', 'config', 'tg_integration'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Umbrella Player',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
