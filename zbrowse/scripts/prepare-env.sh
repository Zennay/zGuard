#!/usr/bin/env bash
set -euo pipefail

env_path="${1:-.env}"
template_path="${2:-.env.example}"

if [[ -L "$env_path" ]]; then
  echo "Refusing to use symlinked environment file: $env_path" >&2
  exit 1
fi

if [[ -e "$env_path" && ! -f "$env_path" ]]; then
  echo "Environment path must be a regular file: $env_path" >&2
  exit 1
fi

if [[ ! -e "$env_path" ]]; then
  if [[ ! -f "$template_path" || -L "$template_path" ]]; then
    echo "Environment template must be a regular non-symlink file: $template_path" >&2
    exit 1
  fi
  cp -- "$template_path" "$env_path"
fi

chmod 600 -- "$env_path"
