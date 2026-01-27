-- Add indexes for frequently queried foreign key columns and filters
-- This improves query performance for common operations

-- Events table indexes
CREATE INDEX IF NOT EXISTS `idx_events_venue_id` ON `events` (`venue_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_promoter_id` ON `events` (`promoter_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_status` ON `events` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_start_date` ON `events` (`start_date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_end_date` ON `events` (`end_date`);
--> statement-breakpoint

-- Event vendors table indexes
CREATE INDEX IF NOT EXISTS `idx_event_vendors_event_id` ON `event_vendors` (`event_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_event_vendors_vendor_id` ON `event_vendors` (`vendor_id`);
--> statement-breakpoint

-- User favorites table indexes
CREATE INDEX IF NOT EXISTS `idx_user_favorites_user_id` ON `user_favorites` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_favorites_type_id` ON `user_favorites` (`favoritable_type`, `favoritable_id`);
--> statement-breakpoint

-- Notifications table indexes
CREATE INDEX IF NOT EXISTS `idx_notifications_user_id` ON `notifications` (`user_id`);
--> statement-breakpoint

-- Accounts table indexes
CREATE INDEX IF NOT EXISTS `idx_accounts_user_id` ON `accounts` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_accounts_provider` ON `accounts` (`provider`, `provider_account_id`);
--> statement-breakpoint

-- Sessions table index
CREATE INDEX IF NOT EXISTS `idx_sessions_user_id` ON `sessions` (`user_id`);
