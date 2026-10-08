-- When a claim that an import created is later moved to another person, the import remembers: undoing the import would otherwise remove claims from an account
-- they have since been handed to. A moved claim makes its import no longer undoable.
ALTER TABLE import_records ADD COLUMN moved_at DATETIME(3) NULL;
