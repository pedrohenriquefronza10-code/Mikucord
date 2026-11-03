"""Create a source-only, credential-free distribution and verify the archive."""
from pathlib import Path
import hashlib
import os
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
destination = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else root.parent / "artifacts" / "Tetocord.zip"
destination.parent.mkdir(parents=True, exist_ok=True)
allowed_directories = {"frontend", "backend", "infra", "coturn", "scripts", "tests", "docs"}
allowed_root_files = {"package.json", "package-lock.json", "README.md", ".env.example", ".gitignore", ".dockerignore", ".prettierignore", ".prettierrc.json", "docker-compose.yml", "docker-compose.media.yml", "docker-compose.media-tls.yml"}
excluded_parts = {"node_modules", "dist", ".git", "test-results", "__pycache__", ".cache"}
allowed_suffixes = {".ts", ".tsx", ".js", ".css", ".html", ".svg", ".png", ".sql", ".json", ".yml", ".yaml", ".conf", ".md", ".mjs", ".py", ".pem", ".txt"}
files = []
for directory, children, names in os.walk(root, followlinks=False):
    parent = Path(directory)
    relative_parent = parent.relative_to(root)
    children[:] = sorted(name for name in children if name not in excluded_parts and (parent != root or name in allowed_directories) and not (parent / name).is_symlink())
    for name in sorted(names):
        path = parent / name
        relative = path.relative_to(root)
        if path.is_symlink() or any(part in excluded_parts for part in relative.parts):
            continue
        if name == ".env" or (name.startswith(".env.") and name != ".env.example") or ".generated." in name or name.endswith((".tsbuildinfo", ".log", ".zip", ".sha256")):
            continue
        if parent == root:
            if name not in allowed_root_files:
                continue
        elif path.suffix not in allowed_suffixes and name not in {"Dockerfile", "Caddyfile", "Caddyfile.media"}:
            continue
        files.append((path, relative))
required = {Path(p) for p in ["README.md", ".env.example", "package-lock.json", "docker-compose.yml", "scripts/setup.mjs", "scripts/media-config.mjs", "infra/certs/empty.pem", "backend/src/index.ts", "frontend/src/App.tsx", "frontend/public/service-worker.js"]}
assert required <= {relative for _, relative in files}, "Required project files are missing"
manifest = []
with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path, relative in sorted(files, key=lambda item: str(item[1])):
        data = path.read_bytes()
        archive.writestr("Tetocord/" + relative.as_posix(), data)
        manifest.append(hashlib.sha256(data).hexdigest() + "  " + relative.as_posix())
    archive.writestr("Tetocord/SHA256SUMS.txt", "\n".join(manifest) + "\n")
with zipfile.ZipFile(destination) as archive:
    assert archive.testzip() is None, "ZIP integrity verification failed"
    names = archive.namelist()
    assert not any(".." in Path(name).parts or name.startswith("/") for name in names)
    assert not any(name.endswith("/.env") or ".generated." in name or "/node_modules/" in name or "/.git/" in name for name in names)
    for line in archive.read("Tetocord/SHA256SUMS.txt").decode().splitlines():
        expected, name = line.split("  ", 1)
        assert hashlib.sha256(archive.read("Tetocord/" + name)).hexdigest() == expected
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
destination.with_suffix(".zip.sha256").write_text(digest + "  " + destination.name + "\n")
print(f"Archive verified: {len(files)} source files; {destination.stat().st_size} bytes")
print(destination)
