from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


root = Path(SPEC).resolve().parent
datas = [(str(root / "src" / "quicksortplayer" / "static"), "quicksortplayer/static")]
binaries = []
hiddenimports = collect_submodules("quicksortplayer")

for package in ("imageio_ffmpeg", "pillow_heif", "pymupdf"):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

analysis = Analysis(
    [str(root / "packaging" / "windows_entry.py")],
    pathex=[str(root / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["pytest", "httpx"],
    noarchive=False,
)

python_archive = PYZ(analysis.pure)

executable = EXE(
    python_archive,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="Quick Sort Player",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
)
