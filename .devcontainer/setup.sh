#!/usr/bin/env bash
# Runs once when the container is created: npm packages, the aligner's venv (CPU torch, as on the VMs), ffmpeg, .env.
set -euo pipefail
cd "$(dirname "$0")/.."

sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg >/dev/null
mkdir -p ~/.local/bin && ln -sf "$(command -v ffmpeg)" ~/.local/bin/ffmpeg   # scripts look for ~/.local/bin/ffmpeg

npm ci --no-audit --no-fund
(cd client && npm ci --no-audit --no-fund)

# scripts/align_timings.py, build_word_timings.py --audio: ~/.venvs/hifz-align, torch CPU wheels (~250 MB)
python3 -m venv ~/.venvs/hifz-align
~/.venvs/hifz-align/bin/pip install -q --upgrade pip
~/.venvs/hifz-align/bin/pip install -q --index-url https://download.pytorch.org/whl/cpu torch torchaudio
~/.venvs/hifz-align/bin/pip install -q numpy uroman

# Codespaces secrets arrive as environment variables; the app and the harnesses read .env
if [ ! -f .env ]; then
  for v in GEMINI_API_KEY ACCESS_KEY; do [ -n "${!v:-}" ] && echo "$v=${!v}" >> .env; done
  [ -f .env ] && echo "setup: .env written from Codespaces secrets" || echo "setup: no secrets found, add GEMINI_API_KEY and ACCESS_KEY to the repository's Codespaces secrets"
fi
echo "setup done: node $(node -v), $(~/.venvs/hifz-align/bin/python -c 'import torch;print("torch",torch.__version__)'), ffmpeg $(ffmpeg -version | head -1 | cut -d' ' -f3)"
