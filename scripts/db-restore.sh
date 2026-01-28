#!/bin/bash
# Database Restore Script for Cloudflare D1
# Usage: ./scripts/db-restore.sh <backup-file> [local|prod]
#
# WARNING: This will overwrite all data in the target database!

set -e

# Configuration
DB_NAME="takemetothefair-db"

# Check arguments
if [ -z "$1" ]; then
    echo "Usage: ./scripts/db-restore.sh <backup-file> [local|prod]"
    echo ""
    echo "Arguments:"
    echo "  backup-file  Path to the SQL backup file"
    echo "  environment  Target environment: 'local' or 'prod' (default: local)"
    echo ""
    echo "Available backups:"
    ls -la ./backups/*.sql 2>/dev/null || echo "  No backups found in ./backups/"
    exit 1
fi

BACKUP_FILE="$1"
ENV="${2:-local}"

# Verify backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: Backup file not found: $BACKUP_FILE"
    exit 1
fi

# Determine environment
if [ "$ENV" = "prod" ]; then
    REMOTE_FLAG="--remote"
    ENV_LABEL="PRODUCTION"
else
    REMOTE_FLAG="--local"
    ENV_LABEL="local"
fi

echo "=================================="
echo "D1 Database Restore"
echo "=================================="
echo "Environment: $ENV_LABEL"
echo "Database: $DB_NAME"
echo "Backup file: $BACKUP_FILE"
echo ""

# Extra warning for production
if [ "$ENV" = "prod" ]; then
    echo "!!! WARNING !!!"
    echo "You are about to restore to PRODUCTION database!"
    echo "This will OVERWRITE all existing data!"
    echo ""
    read -p "Type 'yes-restore-production' to confirm: " CONFIRM
    if [ "$CONFIRM" != "yes-restore-production" ]; then
        echo "Restore cancelled."
        exit 1
    fi
    echo ""
fi

# For restore, we need to:
# 1. Drop existing tables (to avoid conflicts)
# 2. Execute the backup SQL

echo "Step 1: Getting list of existing tables..."

# Get table names (excluding sqlite internal tables)
if [ "$ENV" = "prod" ]; then
    TABLES=$(npx wrangler d1 execute "$DB_NAME" --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'" --json 2>/dev/null | grep -o '"name":"[^"]*"' | sed 's/"name":"//g' | sed 's/"//g' | tr '\n' ' ')
else
    TABLES=$(npx wrangler d1 execute "$DB_NAME" --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'" --json 2>/dev/null | grep -o '"name":"[^"]*"' | sed 's/"name":"//g' | sed 's/"//g' | tr '\n' ' ')
fi

echo "Found tables: $TABLES"
echo ""

echo "Step 2: Dropping existing tables..."
for TABLE in $TABLES; do
    echo "  Dropping $TABLE..."
    npx wrangler d1 execute "$DB_NAME" $REMOTE_FLAG --command "DROP TABLE IF EXISTS \"$TABLE\"" 2>/dev/null || true
done

echo ""
echo "Step 3: Restoring from backup..."
npx wrangler d1 execute "$DB_NAME" $REMOTE_FLAG --file="$BACKUP_FILE"

echo ""
echo "=================================="
echo "Restore completed successfully!"
echo "=================================="

# Verify by counting tables
if [ "$ENV" = "prod" ]; then
    TABLE_COUNT=$(npx wrangler d1 execute "$DB_NAME" --remote --command "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" --json 2>/dev/null | grep -o '"count":[0-9]*' | sed 's/"count"://g')
else
    TABLE_COUNT=$(npx wrangler d1 execute "$DB_NAME" --local --command "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" --json 2>/dev/null | grep -o '"count":[0-9]*' | sed 's/"count"://g')
fi

echo "Tables restored: $TABLE_COUNT"
