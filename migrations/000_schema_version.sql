IF SCHEMA_ID(N'contei') IS NULL EXEC(N'CREATE SCHEMA contei');
CREATE TABLE contei.Migration (
  version varchar(32) NOT NULL PRIMARY KEY,
  appliedAt datetimeoffset(3) NOT NULL DEFAULT TODATETIMEOFFSET(SYSUTCDATETIME(), '+00:00')
);
