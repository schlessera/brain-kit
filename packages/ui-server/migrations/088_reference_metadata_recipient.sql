-- Separate, explicit owner permission for a fixed GitHub metadata recipient.
-- Existing reference grants do not acquire another credential recipient.
ALTER TABLE reference_grants ADD COLUMN metadata_credential_recipient TEXT
  CHECK (metadata_credential_recipient IS NULL OR metadata_credential_recipient = 'https://api.github.com');
