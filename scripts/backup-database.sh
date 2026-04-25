#!/usr/bin/env bash
set -euo pipefail

# Automated PostgreSQL backup with local retention.
# Usage:
#   DATABASE_URL=postgres://... scripts/backup-database.sh
# Optional env:
#   BACKUP_DIR=./backups
#   RETENTION_DAYS=14

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
OUTPUT_FILE="${BACKUP_DIR}/ai-gateway-${TIMESTAMP}.sql.gz"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is required."
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

echo "Creating backup at ${OUTPUT_FILE}"
pg_dump "${DATABASE_URL}" | gzip > "${OUTPUT_FILE}"
echo "Backup complete: ${OUTPUT_FILE}"

# Remove old backups beyond retention period
echo "Pruning backups older than ${RETENTION_DAYS} day(s)"
find "${BACKUP_DIR}" -type f -name "ai-gateway-*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete
echo "Backup rotation complete"
