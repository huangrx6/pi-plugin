# Production Concern

Production environments are irreversible by default. Before touching production state: confirm the change window, verify a rollback path exists, and prefer staged/canary delivery over direct cutover.

Never run exploratory commands against production. Read-only inspection is fine; anything that mutates state needs an explicit plan first.
