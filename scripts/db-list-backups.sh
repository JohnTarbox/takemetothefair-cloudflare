#!/bin/bash
# List available database backups
# Usage: ./scripts/db-list-backups.sh

BACKUP_DIR="./backups"

echo "=================================="
echo "Available Database Backups"
echo "=================================="
echo ""

if [ -d "$BACKUP_DIR" ] && [ "$(ls -A $BACKUP_DIR/*.sql 2>/dev/null)" ]; then
    echo "Location: $BACKUP_DIR"
    echo ""
    printf "%-50s %10s %s\n" "FILENAME" "SIZE" "DATE"
    printf "%-50s %10s %s\n" "--------" "----" "----"

    for file in $BACKUP_DIR/*.sql; do
        if [ -f "$file" ]; then
            FILENAME=$(basename "$file")
            SIZE=$(ls -lh "$file" | awk '{print $5}')
            DATE=$(ls -l "$file" | awk '{print $6, $7, $8}')
            printf "%-50s %10s %s\n" "$FILENAME" "$SIZE" "$DATE"
        fi
    done

    echo ""
    TOTAL=$(ls -1 $BACKUP_DIR/*.sql 2>/dev/null | wc -l)
    TOTAL_SIZE=$(du -sh $BACKUP_DIR 2>/dev/null | awk '{print $1}')
    echo "Total: $TOTAL backup(s), $TOTAL_SIZE"
else
    echo "No backups found in $BACKUP_DIR"
    echo ""
    echo "To create a backup, run:"
    echo "  npm run db:backup        # Backup production"
    echo "  npm run db:backup:local  # Backup local"
fi

echo ""
