-- Files sent "in any format" can be deleted by the team to free space. The request row stays (file name, dates,
-- status) so the visitor's status message and the admin history keep working; only the file bytes go.
ALTER TABLE eh_assisted_uploads ALTER COLUMN data DROP NOT NULL;
ALTER TABLE eh_assisted_uploads ADD COLUMN IF NOT EXISTS file_deleted_at timestamptz;
-- How many bonds the team added for the visitor from this request.
ALTER TABLE eh_assisted_uploads ADD COLUMN IF NOT EXISTS rows_added integer;
