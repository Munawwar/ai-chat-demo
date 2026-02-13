#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PROJECT_ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Repo defaults (can be overridden in .env or shell env)
: "${AWS_PROFILE:=personal}"
: "${AWS_REGION:=eu-west-1}"
: "${STACK_NAME:=ai-chat-stack}"
: "${NAMESPACE:=${STACK_NAME%-stack}}"
: "${MODEL_ID:=minimax.minimax-m2.1}"

export AWS_PROFILE AWS_REGION STACK_NAME NAMESPACE MODEL_ID

exec "$@"
