#!/bin/bash
# Database Backup Script for Cloudflare D1
# Usage: ./scripts/db-backup.sh [local|prod]

set -e

# Configuration
DB_NAME="takemetothefair-db"
BACKUP_DIR="./backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Determine environment
ENV="${1:-prod}"

if [ "$ENV" = "local" ]; then
    REMOTE_FLAG="--local"
    ENV_LABEL="local"
else
    REMOTE_FLAG="--remote"
    ENV_LABEL="production"
fi

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Generate backup filename
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${ENV_LABEL}_${TIMESTAMP}.sql"

echo "=================================="
echo "D1 Database Backup"
echo "=================================="
echo "Environment: $ENV_LABEL"
echo "Database: $DB_NAME"
echo "Output: $BACKUP_FILE"
echo ""

# Export the database
echo "Exporting database..."
npx wrangler d1 export "$DB_NAME" $REMOTE_FLAG --output="$BACKUP_FILE"

# Check if backup was created
if [ -f "$BACKUP_FILE" ]; then
    FILE_SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
    echo ""
    echo "Backup completed successfully!"
    echo "File: $BACKUP_FILE"
    echo "Size: $FILE_SIZE"

    # Count tables and rows
    TABLE_COUNT=$(grep -c "CREATE TABLE" "$BACKUP_FILE" 2>/dev/null || echo "0")
    echo "Tables: $TABLE_COUNT"
    echo ""
    echo "To restore this backup, run:"
    echo "  npm run db:restore -- $BACKUP_FILE"
else
    echo "Error: Backup file was not created"
    exit 1
fi
