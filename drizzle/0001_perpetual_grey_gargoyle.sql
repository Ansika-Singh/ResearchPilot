CREATE TABLE `research_sessions` (
	`id` varchar(36) NOT NULL,
	`goal` text NOT NULL,
	`status` varchar(24) NOT NULL,
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	`snapshot` text NOT NULL,
	CONSTRAINT `research_sessions_id` PRIMARY KEY(`id`)
);
